import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

import { QueryEngine } from '@comunica/query-sparql-solid';
import { Session } from '@inrupt/solid-client-authn-node';



const SCRIPT_FILE = fileURLToPath(import.meta.url);

const HERE = path.dirname(SCRIPT_FILE);

function findProjectRoot(startDirectory) {
  let current = startDirectory;

  while (true) {
    const credentialsDirectory = path.join(
      current,
      'identity_credentials'
    );

    const experimentsDirectory = path.join(
      current,
      'experiments'
    );

    if (
      fs.existsSync(credentialsDirectory) &&
      fs.existsSync(experimentsDirectory)
    ) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(
        [
          'Cannot locate ICDE-Synthea project root.',
          `Script directory: ${HERE}`,
          'Expected a parent directory containing:',
          '  identity_credentials/',
          '  experiments/',
        ].join('\n')
      );
    }

    current = parent;
  }
}

const ROOT = findProjectRoot(HERE);

const EXPERIMENTS = path.join(
  ROOT,
  'experiments'
);

const QUERY_DIR = path.join(
  HERE,
  'queries'
);

const CREDENTIAL_FILE = path.join(
  ROOT,
  'identity_credentials',
  'solid_identities.json'
);

const FEDERATION_SELECTION_FILE = path.join(
  HERE,
  'federation_scale_selections.json'
);

const ANALYSIS = path.join(
  ROOT,
  'synthea',
  'practitioner_access_analysis'
);

const PATIENT_FILE = path.join(
  ANALYSIS,
  'benchmark_patients_balanced',
  'selected_patients_balanced.csv'
);

const PRACTITIONER_FILE = path.join(
  ANALYSIS,
  'benchmark_practitioners',
  'selected_practitioner_patient_access.csv'
);

const COHORT_FILES = {
  R1: path.join(
    ANALYSIS,
    'researcher_cohorts',
    'R1_LOW.csv'
  ),

  R2: path.join(
    ANALYSIS,
    'researcher_cohorts',
    'R2_MEDIUM.csv'
  ),

  R3: path.join(
    ANALYSIS,
    'researcher_cohorts',
    'R3_HIGH.csv'
  ),
};

/* ============================================================
   EXPERIMENT CONSTANTS
   ============================================================ */

const EXPECTED_PODS = 1059;

const EXPECTED_CONFIGURATIONS = 172;

const FEDERATION_SCALES = [
  100,
  250,
  500,
  750,
  1059,
];

const COMUNICA_HTTP_CONCURRENCY = 8;

const CHILD_HEAP_MB = 28672;

const DEFAULT_OIDC_ISSUER =
  'http://localhost:3000/';

const STOP_ON_AUTH_FAILURE = true;

/* ============================================================
   SERVERS
   ============================================================ */

const SERVERS = {
  S1: 3001,
  S2: 3002,
  S3: 3003,
  S4: 3004,
};

/* ============================================================
   QUERIES
   ============================================================ */

const QUERY_FILES = {
  Q01: 'Q01_patient_active_conditions.rq',
  Q02: 'Q02_patient_observations_encounters.rq',
  Q03: 'Q03_patient_medications_procedures.rq',
  Q04: 'Q04_patient_wearable_clinical.rq',

  Q05: 'Q05_practitioner_active_conditions.rq',
  Q06: 'Q06_practitioner_diagnostic_results.rq',
  Q07: 'Q07_practitioner_medication_requests.rq',
  Q08: 'Q08_practitioner_cross_organisation.rq',

  Q09: 'Q09_researcher_condition_prevalence.rq',
  Q10: 'Q10_researcher_encounters_organisations.rq',
  Q11: 'Q11_researcher_observations_organisations.rq',
  Q12: 'Q12_researcher_wearable_patterns.rq',
};

/* ============================================================
   OUTPUT COLUMNS

   Preserve the original CSV schema.
   ============================================================ */

const OUTPUT_COLUMNS = [
  'timestamp',
  'approach',
  'repetition',
  'federationScale',

  'role',
  'identity',
  'accessGroup',
  'query',
  'patientCount',

  'candidateServers',
  'selectedServers',
  'candidatePods',
  'selectedPods',

  'candidateSources',
  'accessibleOriginalSources',
  'deniedOriginalSources',
  'selectedSources',

  'selectedSourceBytes',
  'selectedSourceMB',

  'rdfBytesTransferred',
  'rdfMBTransferred',

  'sourceDiscoveryMs',
  'accessCheckMs',
  'sourceSelectionMs',
  'comunicaMs',
  'totalMs',

  'accessCheckHttpRequests',
  'queryHttpRequests',
  'httpRequests',

  'httpOk',
  'httpError',
  'uniqueHttpUrls',

  'results',
  'resultHash',

  'status',
  'error',

  'cpuUserMs',
  'cpuSystemMs',
  'peakMemoryMB',
];

/* ============================================================
   GENERAL HELPERS
   ============================================================ */

function fatal(message) {
  throw new Error(message);
}

function bytesToMB(bytes) {
  return bytes / (1024 * 1024);
}

function formatError(error) {
  const parts = [];

  if (error?.stack) {
    parts.push(error.stack);
  } else if (error?.message) {
    parts.push(error.message);
  } else {
    parts.push(String(error));
  }

  let cause = error?.cause;
  let depth = 0;

  while (cause && depth < 5) {
    if (cause.code) {
      parts.push(
        `CAUSE_CODE=${cause.code}`
      );
    }

    if (cause.message) {
      parts.push(
        `CAUSE_MESSAGE=${cause.message}`
      );
    }

    cause = cause.cause;
    depth++;
  }

  return [...new Set(parts)].join('\n');
}

function printFailure(label, error) {
  console.error(
    '\n============================================================'
  );

  console.error(label);

  console.error(
    '============================================================'
  );

  console.error(
    formatError(error)
  );

  console.error(
    '============================================================\n'
  );
}

/* ============================================================
   CSV PARSER

   Correctly handles:
   - quoted fields
   - commas inside quoted fields
   - escaped quotes
   - multiline error stack traces

   The previous parser incorrectly split quoted multiline
   errors into separate CSV rows.
   ============================================================ */

function csvEscape(value) {
  const text = String(value ?? '');

  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return (
      '"' +
      text.replaceAll('"', '""') +
      '"'
    );
  }

  return text;
}

function parseCsvRecords(text) {
  const records = [];

  let record = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (
        quoted &&
        text[i + 1] === '"'
      ) {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (
      char === ',' &&
      !quoted
    ) {
      record.push(field);
      field = '';
      continue;
    }

    if (
      (char === '\n' || char === '\r') &&
      !quoted
    ) {
      if (
        char === '\r' &&
        text[i + 1] === '\n'
      ) {
        i++;
      }

      record.push(field);

      if (
        record.some(
          value => value !== ''
        )
      ) {
        records.push(record);
      }

      record = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (quoted) {
    throw new Error(
      'Malformed CSV: unterminated quoted field.'
    );
  }

  if (
    field !== '' ||
    record.length > 0
  ) {
    record.push(field);

    records.push(record);
  }

  return records;
}

function parseCsv(text) {
  const records = parseCsvRecords(text);

  if (!records.length) {
    return [];
  }

  const header = records[0];

  return records.slice(1).map(values => {
    const row = {};

    header.forEach(
      (column, index) => {
        row[column] =
          values[index] ?? '';
      }
    );

    return row;
  });
}

function readCsv(file) {
  if (!fs.existsSync(file)) {
    fatal(
      `Missing CSV: ${file}`
    );
  }

  return parseCsv(
    fs.readFileSync(
      file,
      'utf8'
    )
  );
}

/* ============================================================
   COMMAND-LINE ARGUMENTS
   ============================================================ */

function getFederationScale() {
  const index = process.argv.indexOf(
    '--scale'
  );

  if (index === -1) {
    fatal(
      `Missing --scale. Allowed scales: ${FEDERATION_SCALES.join(', ')}`
    );
  }

  const scale = Number(
    process.argv[index + 1]
  );

  if (
    !FEDERATION_SCALES.includes(scale)
  ) {
    fatal(
      `Invalid --scale ${process.argv[index + 1]}. ` +
      `Allowed scales: ${FEDERATION_SCALES.join(', ')}`
    );
  }

  return scale;
}

function getRepetitionCount() {
  const index = process.argv.indexOf(
    '--repetitions'
  );

  if (index === -1) {
    return 1;
  }

  const value = Number(
    process.argv[index + 1]
  );

  if (
    !Number.isInteger(value) ||
    value < 1
  ) {
    fatal(
      '--repetitions must be a positive integer.'
    );
  }

  return value;
}

function outputFileForScale(scale) {
  return path.join(
    HERE,
    `experiment_baseline_scale_${scale}.csv`
  );
}

/* ============================================================
   CSV OUTPUT
   ============================================================ */

function expectedHeader() {
  return OUTPUT_COLUMNS.join(',');
}

function ensureOutputSchema(outputFile) {
  if (!fs.existsSync(outputFile)) {
    fs.writeFileSync(
      outputFile,
      expectedHeader() + '\n',
      'utf8'
    );

    return;
  }

  const firstLine = fs
    .readFileSync(
      outputFile,
      'utf8'
    )
    .split(/\r?\n/, 1)[0];

  if (
    firstLine !== expectedHeader()
  ) {
    fatal(
      [
        `${path.basename(outputFile)} uses a different schema.`,
        `Expected: ${expectedHeader()}`,
        `Found:    ${firstLine}`,
        'The existing CSV was NOT modified.',
      ].join('\n')
    );
  }
}

function appendCsv(outputFile, row) {
  ensureOutputSchema(outputFile);

  const line =
    OUTPUT_COLUMNS
      .map(
        column => csvEscape(row[column])
      )
      .join(',') +
    '\n';

  fs.appendFileSync(
    outputFile,
    line,
    'utf8'
  );
}

/* ============================================================
   CREDENTIAL LOADING
   ============================================================ */

function normalizeCredentials(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }

  for (const key of [
    'identities',
    'credentials',
    'solidIdentities',
    'accounts',
  ]) {
    if (
      Array.isArray(raw?.[key])
    ) {
      return raw[key];
    }
  }

  if (
    raw &&
    typeof raw === 'object'
  ) {
    return Object
      .values(raw)
      .filter(
        value =>
          value &&
          typeof value === 'object'
      );
  }

  return [];
}

function sourceIdOf(credential) {
  return String(
    credential?.sourceId ??
    credential?.source_id ??
    credential?.id ??
    ''
  );
}

function roleOf(credential) {
  return String(
    credential?.role ?? ''
  ).toLowerCase();
}

function credentialFor(
  credentials,
  role,
  sourceId
) {
  const targetRole =
    String(role).toLowerCase();

  const targetId =
    String(sourceId).toLowerCase();

  const candidates = new Set([
    targetId,
    `${targetRole}_${targetId}`,
  ]);

  const credential = credentials.find(
    item => {
      const itemRole = roleOf(item);

      const itemId = sourceIdOf(
        item
      ).toLowerCase();

      return (
        itemRole === targetRole &&
        candidates.has(itemId)
      );
    }
  );

  if (!credential) {
    throw new Error(
      `Credential not found: role=${role}, sourceId=${sourceId}`
    );
  }

  return credential;
}

/* ============================================================
   AUTHENTICATION

   Use the existing credential values.

   Do not generate clients.
   Do not replace client IDs.
   Do not replace client secrets.
   Do not inspect or modify identity storage.

   IMPORTANT:
   A valid credential can still receive invalid_client
   if CSS is running against the wrong identity storage.
   ============================================================ */

function normalizeIssuer(value) {
  if (
    typeof value !== 'string' ||
    !value.trim()
  ) {
    throw new Error(
      'Missing OIDC issuer.'
    );
  }

  const url = new URL(
    value.trim()
  );

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error(
      `Invalid OIDC issuer protocol: ${url.protocol}`
    );
  }

  url.hash = '';
  url.search = '';

  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }

  return url.toString();
}

function authFields(credential) {
  const clientId =
    credential.tokenIdentifier ??
    credential.token_identifier ??
    credential.clientId ??
    credential.client_id;

  const clientSecret =
    credential.tokenSecret ??
    credential.token_secret ??
    credential.clientSecret ??
    credential.client_secret;

  /*
   * Prefer an explicitly stored OIDC issuer.
   * Fall back to cssBaseUrl only when no issuer exists.
   */
  const issuerValue =
    credential.oidcIssuer ??
    credential.oidc_issuer ??
    credential.cssBaseUrl ??
    credential.css_base_url ??
    DEFAULT_OIDC_ISSUER;

  if (
    typeof clientId !== 'string' ||
    !clientId.trim()
  ) {
    throw new Error(
      `Missing client ID for ${sourceIdOf(credential)}`
    );
  }

  if (
    typeof clientSecret !== 'string' ||
    !clientSecret
  ) {
    throw new Error(
      `Missing client secret for ${sourceIdOf(credential)}`
    );
  }

  const oidcIssuer = normalizeIssuer(
    issuerValue
  );

  console.log(
    `    Authentication issuer: ${oidcIssuer}`
  );

  console.log(
    '    Client ID present: yes'
  );

  console.log(
    '    Client secret present: yes'
  );

  return {
    clientId,
    clientSecret,
    oidcIssuer,
  };
}

/* ============================================================
   FILE WALK
   ============================================================ */

function safeWalk(root, callback) {
  if (!fs.existsSync(root)) {
    return;
  }

  const stack = [root];

  while (stack.length) {
    const current = stack.pop();

    let entries;

    try {
      entries = fs.readdirSync(
        current,
        {
          withFileTypes: true,
        }
      );
    } catch (error) {
      if (
        error?.code === 'ENOENT'
      ) {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name === '.internal'
      ) {
        continue;
      }

      const fullPath = path.join(
        current,
        entry.name
      );

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        callback(fullPath);
      }
    }
  }
}

/* ============================================================
   SOURCE URL CONSTRUCTION
   ============================================================ */

function fileToUrl(server, file) {
  const serverRoot = path.join(
    EXPERIMENTS,
    server
  );

  const relative = path
    .relative(serverRoot, file)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');

  return (
    `http://localhost:${SERVERS[server]}/` +
    relative
  );
}

/* ============================================================
   POD IDENTIFICATION
   ============================================================ */

function inferPod(server, file) {
  const serverRoot = path.join(
    EXPERIMENTS,
    server
  );

  const relative = path.relative(
    serverRoot,
    file
  );

  const parts = relative.split(
    path.sep
  );

  for (
    let i = 0;
    i < parts.length - 1;
    i++
  ) {
    if (
      parts[i] === 'facility_pods' &&
      i + 2 < parts.length
    ) {
      return parts[i + 2];
    }

    if (
      parts[i] === 'patient_pods' &&
      i + 1 < parts.length
    ) {
      return parts[i + 1];
    }
  }

  const patientDirectory = parts.find(
    part =>
      /^patient_[0-9a-fA-F-]{36}$/.test(part)
  );

  return patientDirectory ?? '';
}

function podKey(item) {
  return `${item.server}/${item.pod}`;
}

/* ============================================================
   FEDERATION DISCOVERY

   ORIGINAL .nq SOURCES ONLY.
   ============================================================ */

function discoverFederationSources() {
  const sources = [];

  for (
    const server
    of Object.keys(SERVERS)
  ) {
    const root = path.join(
      EXPERIMENTS,
      server
    );

    safeWalk(root, file => {
      if (
        !file.endsWith('.nq')
      ) {
        return;
      }

      let sizeBytes = 0;

      try {
        sizeBytes = fs.statSync(
          file
        ).size;
      } catch {
        // Preserve the candidate URL.
      }

      const pod = inferPod(
        server,
        file
      );

      if (!pod) {
        return;
      }

      sources.push({
        server,
        pod,
        file,
        url: fileToUrl(server, file),
        sizeBytes,
      });
    });
  }

  sources.sort(
    (a, b) =>
      a.url.localeCompare(b.url)
  );

  return sources;
}

/* ============================================================
   FEDERATION COUNTS
   ============================================================ */

function uniqueServerCount(sources) {
  return new Set(
    sources.map(
      item => item.server
    )
  ).size;
}

function uniquePodCount(sources) {
  return new Set(
    sources
      .filter(item => item.pod)
      .map(
        item =>
          `${item.server}/${item.pod}`
      )
  ).size;
}

/* ============================================================
   FIXED NESTED FEDERATION SELECTION

   Use the exact VM selections.
   No random resampling.
   ============================================================ */

function federationPodOrder(
  fullFederationSources
) {
  if (
    !fs.existsSync(
      FEDERATION_SELECTION_FILE
    )
  ) {
    fatal(
      `Missing federation selection file: ${FEDERATION_SELECTION_FILE}`
    );
  }

  const selections = JSON.parse(
    fs.readFileSync(
      FEDERATION_SELECTION_FILE,
      'utf8'
    )
  );

  const actualPodKeys = new Set(
    fullFederationSources.map(
      podKey
    )
  );

  for (
    const scale
    of FEDERATION_SCALES
  ) {
    const selected =
      selections[String(scale)];

    if (
      !Array.isArray(selected)
    ) {
      fatal(
        `Missing federation selection for scale ${scale}`
      );
    }

    if (
      selected.length !== scale
    ) {
      fatal(
        `Scale ${scale}: expected ${scale} pods, found ${selected.length}`
      );
    }

    if (
      new Set(selected).size !== scale
    ) {
      fatal(
        `Scale ${scale} contains duplicate pod keys.`
      );
    }

    for (const key of selected) {
      if (
        !actualPodKeys.has(key)
      ) {
        fatal(
          `Federation pod missing from Mac dataset: ${key}`
        );
      }
    }
  }

  for (
    let i = 0;
    i < FEDERATION_SCALES.length - 1;
    i++
  ) {
    const smallerScale =
      FEDERATION_SCALES[i];

    const largerScale =
      FEDERATION_SCALES[i + 1];

    const smaller =
      selections[String(smallerScale)];

    const larger = new Set(
      selections[String(largerScale)]
    );

    for (const key of smaller) {
      if (
        !larger.has(key)
      ) {
        fatal(
          `Federation nesting violation: ${smallerScale} is not contained in ${largerScale}`
        );
      }
    }
  }

  const fullSelection =
    selections['1059'];

  if (
    actualPodKeys.size !== EXPECTED_PODS ||
    fullSelection.some(
      key => !actualPodKeys.has(key)
    )
  ) {
    fatal(
      'Mac federation does not match the VM federation.'
    );
  }

  const requestedScale =
    getFederationScale();

  const selectedPods =
    selections[String(requestedScale)];

  const selectedSet = new Set(
    selectedPods
  );

  const remainingPods =
    fullSelection.filter(
      key => !selectedSet.has(key)
    );

  return [
    ...selectedPods,
    ...remainingPods,
  ];
}

function selectFederationScale(
  fullFederationSources,
  scale
) {
  const orderedPods =
    federationPodOrder(
      fullFederationSources
    );

  if (
    orderedPods.length !== EXPECTED_PODS
  ) {
    fatal(
      `Expected ${EXPECTED_PODS} total pods, found ${orderedPods.length}`
    );
  }

  if (
    scale > orderedPods.length
  ) {
    fatal(
      `Requested scale ${scale} exceeds available pods ${orderedPods.length}`
    );
  }

  const selectedPodKeys = new Set(
    orderedPods.slice(
      0,
      scale
    )
  );

  const selectedSources =
    fullFederationSources.filter(
      item =>
        selectedPodKeys.has(
          podKey(item)
        )
    );

  const actualPods =
    uniquePodCount(
      selectedSources
    );

  if (
    actualPods !== scale
  ) {
    fatal(
      `Federation scale construction failed: requested ${scale}, selected ${actualPods} pods`
    );
  }

  return selectedSources;
}

/* ============================================================
   SELECTED PATIENTS
   ============================================================ */

function selectedPatients() {
  const rows = readCsv(
    PATIENT_FILE
  );

  const patients = new Map();

  for (const row of rows) {
    const id =
      row.patient_id ??
      row.source_id;

    if (!id) {
      continue;
    }

    const patientId =
      id.toLowerCase();

    const accessGroup =
      row.distribution_group ??
      row.distributionGroup ??
      '';

    patients.set(
      patientId,
      accessGroup
    );
  }

  if (
    patients.size !== 20
  ) {
    fatal(
      `Expected 20 selected patients, found ${patients.size}`
    );
  }

  return patients;
}

/* ============================================================
   PRACTITIONER ACCESS
   ============================================================ */

function practitionerAccess() {
  const rows = readCsv(
    PRACTITIONER_FILE
  );

  const map = new Map();

  for (const row of rows) {
    const practitioner =
      row.practitioner_id?.toLowerCase();

    const patient =
      row.patient_id?.toLowerCase();

    if (
      !practitioner ||
      !patient
    ) {
      continue;
    }

    if (
      !map.has(practitioner)
    ) {
      map.set(
        practitioner,
        new Set()
      );
    }

    map.get(
      practitioner
    ).add(patient);
  }

  if (
    map.size !== 20
  ) {
    fatal(
      `Expected 20 selected practitioners, found ${map.size}`
    );
  }

  return map;
}

/* ============================================================
   RESEARCHER COHORTS
   ============================================================ */

function loadCohort(name) {
  const file =
    COHORT_FILES[name];

  if (!file) {
    throw new Error(
      `Unknown cohort ${name}`
    );
  }

  return new Set(
    readCsv(file)
      .map(
        row =>
          row.patient_id?.toLowerCase()
      )
      .filter(Boolean)
  );
}

/* ============================================================
   WEARABLE PATIENTS
   ============================================================ */

function patientIdFromPath(file) {
  const normalized = file
    .split(path.sep)
    .join('/');

  const match = normalized.match(
    /patient_([0-9a-fA-F-]{36})/
  );

  return match
    ? match[1].toLowerCase()
    : null;
}

function wearablePatients(
  federationSources
) {
  const result = new Set();

  for (
    const item
    of federationSources
  ) {
    const normalized = item.file
      .split(path.sep)
      .join('/');

    if (
      !normalized.includes(
        '/wearable_data/'
      )
    ) {
      continue;
    }

    const patientId =
      patientIdFromPath(
        item.file
      );

    if (patientId) {
      result.add(
        patientId
      );
    }
  }

  return result;
}

/* ============================================================
   QUERY LOADING
   ============================================================ */

function queryTemplate(queryId) {
  const filename =
    QUERY_FILES[queryId];

  if (!filename) {
    throw new Error(
      `Unknown query ${queryId}`
    );
  }

  const file = path.join(
    QUERY_DIR,
    filename
  );

  if (
    !fs.existsSync(file)
  ) {
    throw new Error(
      `Missing query file: ${file}`
    );
  }

  return fs.readFileSync(
    file,
    'utf8'
  );
}

function patientUri(id) {
  return (
    '<http://example.org/synthea/data/Patient/' +
    id +
    '>'
  );
}

function instantiatePatientQuery(
  template,
  patientId
) {
  if (!patientId) {
    throw new Error(
      'Cannot instantiate patient query without patient ID.'
    );
  }

  const query =
    template.replaceAll(
      '{{PATIENT_ID}}',
      patientId
    );

  if (
    query.includes(
      '{{PATIENT_ID}}'
    )
  ) {
    throw new Error(
      'PATIENT_ID placeholder remained after query instantiation.'
    );
  }

  return query;
}

function instantiateCohortQuery(
  template,
  patientIds
) {
  const values = patientIds
    .map(patientUri)
    .join('\n    ');

  const query =
    template.replaceAll(
      '{{COHORT_PATIENT_URIS}}',
      values
    );

  if (
    query.includes(
      '{{COHORT_PATIENT_URIS}}'
    )
  ) {
    throw new Error(
      'COHORT_PATIENT_URIS placeholder remained after query instantiation.'
    );
  }

  return query;
}

/* ============================================================
   172 CONFIGURATIONS
   ============================================================ */

function makeConfigurations({
  patients,
  practitioners,
  cohorts,
  wearableSet,
}) {
  const configs = [];

  /*
   * PATIENT:
   * 20 patients × 4 queries = 80
   */
  for (
    const [
      patientId,
      distributionGroup,
    ]
    of patients.entries()
  ) {
    for (
      const queryId
      of [
        'Q01',
        'Q02',
        'Q03',
        'Q04',
      ]
    ) {
      configs.push({
        role: 'patient',
        identity: patientId,
        queryId,
        patientIds: [
          patientId,
        ],
        accessGroup:
          distributionGroup,
      });
    }
  }

  /*
   * PRACTITIONER:
   * 20 practitioners × 4 queries = 80
   */
  for (
    const [
      practitionerId,
      patientSet,
    ]
    of practitioners.entries()
  ) {
    const authorisedPatients = [
      ...patientSet,
    ].sort();

    if (
      !authorisedPatients.length
    ) {
      throw new Error(
        `Practitioner ${practitionerId} has no authorised patients.`
      );
    }

    const patientId =
      authorisedPatients[0];

    const accessGroup =
      authorisedPatients.length === 1
        ? 'LOW'
        : authorisedPatients.length <= 3
          ? 'MEDIUM'
          : 'HIGH';

    for (
      const queryId
      of [
        'Q05',
        'Q06',
        'Q07',
        'Q08',
      ]
    ) {
      configs.push({
        role: 'practitioner',
        identity: practitionerId,
        queryId,
        patientIds: [
          patientId,
        ],
        authorisedPatientIds:
          authorisedPatients,
        accessGroup,
      });
    }
  }

  /*
   * RESEARCHER:
   * 3 cohorts × 4 queries = 12
   */
  for (
    const cohortName
    of [
      'R1',
      'R2',
      'R3',
    ]
  ) {
    const clinicalPatients = [
      ...cohorts[cohortName],
    ].sort();

    for (
      const queryId
      of [
        'Q09',
        'Q10',
        'Q11',
      ]
    ) {
      configs.push({
        role: 'researcher',
        identity: cohortName,
        queryId,
        patientIds:
          clinicalPatients,
        accessGroup:
          cohortName,
      });
    }

    const wearableCohort =
      clinicalPatients.filter(
        patientId =>
          wearableSet.has(
            patientId
          )
      );

    configs.push({
      role: 'researcher',
      identity: cohortName,
      queryId: 'Q12',
      patientIds:
        wearableCohort,
      accessGroup:
        cohortName,
    });
  }

  return configs;
}

/* ============================================================
   BUILD WORKLOAD

   Always construct the SAME 172 configurations
   from the complete 1059-pod federation.
   ============================================================ */

function buildWorkload(
  fullFederationSources
) {
  const wearableSet =
    wearablePatients(
      fullFederationSources
    );

  const patients =
    selectedPatients();

  const practitioners =
    practitionerAccess();

  const cohorts = {
    R1: loadCohort('R1'),
    R2: loadCohort('R2'),
    R3: loadCohort('R3'),
  };

  const configurations =
    makeConfigurations({
      patients,
      practitioners,
      cohorts,
      wearableSet,
    });

  if (
    configurations.length !==
    EXPECTED_CONFIGURATIONS
  ) {
    fatal(
      `Expected ${EXPECTED_CONFIGURATIONS} configurations, found ${configurations.length}`
    );
  }

  return configurations;
}

/* ============================================================
   HTTP METRICS
   ============================================================ */

function newHttpStats() {
  return {
    requests: 0,
    ok: 0,
    error: 0,
    uniqueUrls: new Set(),
    bytes: 0,
  };
}

function requestUrl(args) {
  const first = args[0];

  if (
    first &&
    typeof first === 'object' &&
    typeof first.url === 'string'
  ) {
    return first.url;
  }

  return String(first);
}

function recordResponseBytes(
  response,
  stats
) {
  const contentLength = Number(
    response.headers?.get?.(
      'content-length'
    )
  );

  if (
    Number.isFinite(
      contentLength
    ) &&
    contentLength > 0
  ) {
    stats.bytes +=
      contentLength;
  }
}

function makeCountingFetch(
  baseFetch,
  stats = newHttpStats()
) {
  const countingFetch =
    async (...args) => {
      const url =
        requestUrl(args);

      stats.requests++;

      stats.uniqueUrls.add(
        url
      );

      try {
        const response =
          await baseFetch(
            ...args
          );

        if (response.ok) {
          stats.ok++;
        } else {
          stats.error++;
        }

        recordResponseBytes(
          response,
          stats
        );

        return response;
      } catch (error) {
        stats.error++;
        throw error;
      }
    };

  countingFetch.stats =
    stats;

  return countingFetch;
}

/* ============================================================
   BOUNDED AUTHENTICATED FETCH
   ============================================================ */

function makeBoundedCountingFetch(
  baseFetch,
  limit
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    throw new Error(
      `Invalid HTTP concurrency limit: ${limit}`
    );
  }

  const stats =
    newHttpStats();

  let active = 0;

  const queue = [];

  async function acquire() {
    if (
      active < limit
    ) {
      active++;
      return;
    }

    await new Promise(
      resolve => {
        queue.push(
          resolve
        );
      }
    );

    active++;
  }

  function release() {
    active--;

    const next =
      queue.shift();

    if (next) {
      next();
    }
  }

  const boundedFetch =
    async (...args) => {
      await acquire();

      const url =
        requestUrl(args);

      stats.requests++;

      stats.uniqueUrls.add(
        url
      );

      try {
        const response =
          await baseFetch(
            ...args
          );

        if (response.ok) {
          stats.ok++;
        } else {
          stats.error++;
        }

        recordResponseBytes(
          response,
          stats
        );

        return response;
      } catch (error) {
        stats.error++;
        throw error;
      } finally {
        release();
      }
    };

  boundedFetch.stats =
    stats;

  return boundedFetch;
}

/* ============================================================
   ACCESS CHECK

   Sequential GET against every original RDF URL.
   No source filtering.
   No cached RDF bodies.
   ============================================================ */

async function canFetchRdf(
  item,
  customFetch
) {
  try {
    const response =
      await customFetch(
        item.url,
        {
          method: 'GET',
          headers: {
            accept:
              'application/n-quads,text/plain,text/turtle,application/ld+json,*/*',
          },
        }
      );

    const ok =
      response.ok;

    const status =
      response.status;

    try {
      await response.body?.cancel?.();
    } catch {
      // Ignore body cancellation errors.
    }

    return {
      ok,
      status,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      status: 'FETCH_ERROR',
      error:
        formatError(error),
    };
  }
}

async function selectAccessibleSources(
  allSources,
  customFetch
) {
  const accessible = [];
  const denied = [];

  let checked = 0;

  for (
    const item
    of allSources
  ) {
    checked++;

    if (
      checked === 1 ||
      checked % 1000 === 0 ||
      checked === allSources.length
    ) {
      console.log(
        `    Access checked ${checked}/${allSources.length}`
      );
    }

    const result =
      await canFetchRdf(
        item,
        customFetch
      );

    if (result.ok) {
      accessible.push(
        item
      );
    } else {
      denied.push({
        ...item,
        accessStatus:
          result.status,
        accessError:
          result.error ?? '',
      });
    }
  }

  return {
    accessible,
    denied,
  };
}

/* ============================================================
   RESULT HASH
   ============================================================ */

function bindingCanonicalString(
  binding
) {
  const entries = [];

  for (
    const [
      variable,
      term,
    ]
    of binding
  ) {
    entries.push(
      `${variable.value}=${term.termType}:${term.value}`
    );
  }

  entries.sort();

  return entries.join('|');
}

function resultSetHash(rows) {
  const sorted = [
    ...rows,
  ].sort();

  const hash =
    crypto.createHash(
      'sha256'
    );

  for (
    const row
    of sorted
  ) {
    hash.update(
      row
    );

    hash.update(
      '\n'
    );
  }

  return hash.digest(
    'hex'
  );
}

/* ============================================================
   COMUNICA

   Every accessible original RDF URL is supplied.
   ============================================================ */

async function runComunica({
  queryText,
  accessibleSources,
  session,
}) {
  const urls =
    accessibleSources.map(
      item => item.url
    );

  const emptyHttp =
    newHttpStats();

  if (
    !urls.length
  ) {
    return {
      resultCount: 0,
      resultHash:
        resultSetHash([]),
      runtimeMs: 0,
      http: emptyHttp,
      status: 'PASS',
      error: '',
    };
  }

  const originalSessionFetch =
    session.fetch.bind(
      session
    );

  const queryFetch =
    makeBoundedCountingFetch(
      originalSessionFetch,
      COMUNICA_HTTP_CONCURRENCY
    );

  session.fetch =
    queryFetch;

  const engine =
    new QueryEngine();

  const start =
    performance.now();

  try {
    const stream =
      await engine.queryBindings(
        queryText,
        {
          sources: urls,

          '@comunica/actor-http-inrupt-solid-client-authn:session':
            session,

          httpRetryCount: 0,
        }
      );

    let resultCount = 0;

    const canonicalRows = [];

    for await (
      const binding
      of stream
    ) {
      resultCount++;

      canonicalRows.push(
        bindingCanonicalString(
          binding
        )
      );
    }

    return {
      resultCount,

      resultHash:
        resultSetHash(
          canonicalRows
        ),

      runtimeMs:
        performance.now() -
        start,

      http:
        queryFetch.stats,

      status: 'PASS',

      error: '',
    };
  } catch (error) {
    return {
      resultCount: 0,

      resultHash: '',

      runtimeMs:
        performance.now() -
        start,

      http:
        queryFetch.stats,

      status:
        'QUERY_ERROR',

      error:
        formatError(error),
    };
  } finally {
    session.fetch =
      originalSessionFetch;
  }
}

/* ============================================================
   CPU AND MEMORY
   ============================================================ */

function memoryMB() {
  return (
    process.memoryUsage().rss /
    (1024 * 1024)
  );
}

function cpuDifferenceMs(
  before,
  after
) {
  return {
    user:
      (
        after.user -
        before.user
      ) / 1000,

    system:
      (
        after.system -
        before.system
      ) / 1000,
  };
}

/* ============================================================
   EXECUTION KEY
   ============================================================ */

function executionKey(
  config,
  repetition
) {
  return [
    config.role,
    config.identity,
    config.queryId,
    config.accessGroup,
    repetition,
  ].join('|');
}

/* ============================================================
   RESUME COMPLETED EXECUTIONS
   ============================================================ */

function completedExecutions(
  outputFile
) {
  const completed =
    new Set();

  if (
    !fs.existsSync(
      outputFile
    )
  ) {
    return completed;
  }

  ensureOutputSchema(
    outputFile
  );

  const rows = parseCsv(
    fs.readFileSync(
      outputFile,
      'utf8'
    )
  );

  for (
    const row
    of rows
  ) {
    if (
      row.status !== 'PASS'
    ) {
      continue;
    }

    completed.add(
      [
        row.role,
        row.identity,
        row.query,
        row.accessGroup,
        row.repetition,
      ].join('|')
    );
  }

  return completed;
}

/* ============================================================
   FAILURE ROW
   ============================================================ */

function makeFailureRow({
  config,
  repetition,
  federationScale,
  federationSources,
  discoveryMs = 0,
  accessCheckMs = 0,
  accessFetch = null,
  accessible = [],
  denied = [],
  status,
  error,
  cpu = null,
  peakMemory = null,
}) {
  const candidateServers =
    uniqueServerCount(
      federationSources
    );

  const candidatePods =
    uniquePodCount(
      federationSources
    );

  const selectedServers =
    uniqueServerCount(
      accessible
    );

  const selectedPods =
    uniquePodCount(
      accessible
    );

  const selectedSourceBytes =
    accessible.reduce(
      (sum, item) =>
        sum + item.sizeBytes,
      0
    );

  const stats =
    accessFetch?.stats ??
    newHttpStats();

  return {
    timestamp:
      new Date().toISOString(),

    approach:
      'baseline',

    repetition,
    federationScale,

    role:
      config?.role ?? '',

    identity:
      config?.identity ?? '',

    accessGroup:
      config?.accessGroup ?? '',

    query:
      config?.queryId ?? '',

    patientCount:
      config?.patientIds?.length ?? 0,

    candidateServers,
    selectedServers,

    candidatePods,
    selectedPods,

    candidateSources:
      federationSources.length,

    accessibleOriginalSources:
      accessible.length,

    deniedOriginalSources:
      denied.length,

    selectedSources:
      accessible.length,

    selectedSourceBytes,

    selectedSourceMB:
      bytesToMB(
        selectedSourceBytes
      ).toFixed(6),

    rdfBytesTransferred:
      stats.bytes,

    rdfMBTransferred:
      bytesToMB(
        stats.bytes
      ).toFixed(6),

    sourceDiscoveryMs:
      Number(
        discoveryMs
      ).toFixed(3),

    accessCheckMs:
      Number(
        accessCheckMs
      ).toFixed(3),

    sourceSelectionMs:
      (
        Number(discoveryMs) +
        Number(accessCheckMs)
      ).toFixed(3),

    comunicaMs:
      '0.000',

    totalMs:
      (
        Number(discoveryMs) +
        Number(accessCheckMs)
      ).toFixed(3),

    accessCheckHttpRequests:
      stats.requests,

    queryHttpRequests:
      0,

    httpRequests:
      stats.requests,

    httpOk:
      stats.ok,

    httpError:
      stats.error,

    uniqueHttpUrls:
      stats.uniqueUrls.size,

    results:
      0,

    resultHash:
      '',

    status,
    error,

    cpuUserMs:
      cpu
        ? cpu.user.toFixed(3)
        : '0.000',

    cpuSystemMs:
      cpu
        ? cpu.system.toFixed(3)
        : '0.000',

    peakMemoryMB:
      (
        peakMemory ??
        memoryMB()
      ).toFixed(3),
  };
}

function tryAppendFailureRow(
  outputFile,
  args
) {
  try {
    appendCsv(
      outputFile,
      makeFailureRow(args)
    );

    return true;
  } catch (error) {
    printFailure(
      'FAILED TO WRITE FAILURE ROW',
      error
    );

    return false;
  }
}

/* ============================================================
   CHILD EXECUTION

   One configuration.
   One authenticated session.
   One access-check pass.
   One Comunica query.
   One CSV row.
   ============================================================ */

async function runChild() {
  const childIndexPosition =
    process.argv.indexOf(
      '--child-index'
    );

  const repetitionPosition =
    process.argv.indexOf(
      '--child-repetition'
    );

  if (
    childIndexPosition === -1 ||
    repetitionPosition === -1
  ) {
    throw new Error(
      'Missing child execution arguments.'
    );
  }

  const federationScale =
    getFederationScale();

  const outputFile =
    outputFileForScale(
      federationScale
    );

  const configIndex = Number(
    process.argv[
      childIndexPosition + 1
    ]
  );

  const repetition = Number(
    process.argv[
      repetitionPosition + 1
    ]
  );

  if (
    !Number.isInteger(
      configIndex
    ) ||
    configIndex < 0
  ) {
    throw new Error(
      `Invalid child configuration index: ${configIndex}`
    );
  }

  if (
    !Number.isInteger(
      repetition
    ) ||
    repetition < 1
  ) {
    throw new Error(
      `Invalid child repetition: ${repetition}`
    );
  }

  let fullFederationSources = [];
  let federationSources = [];
  let configurations = [];
  let config = null;

  let discoveryMs = 0;
  let accessCheckMs = 0;

  let accessible = [];
  let denied = [];

  let accessFetch = null;
  let session = null;

  let memoryTimer = null;

  let peakMemory =
    memoryMB();

  let cpuBefore = null;

  /* ==========================================================
     DISCOVERY AND CONFIGURATION
     ========================================================== */

  try {
    const discoveryStart =
      performance.now();

    fullFederationSources =
      discoverFederationSources();

    if (
      !fullFederationSources.length
    ) {
      throw new Error(
        'No RDF sources discovered.'
      );
    }

    const fullPodCount =
      uniquePodCount(
        fullFederationSources
      );

    if (
      fullPodCount !==
      EXPECTED_PODS
    ) {
      throw new Error(
        `Expected ${EXPECTED_PODS} total pods; detected ${fullPodCount}`
      );
    }

    federationSources =
      selectFederationScale(
        fullFederationSources,
        federationScale
      );

    discoveryMs =
      performance.now() -
      discoveryStart;

    configurations =
      buildWorkload(
        fullFederationSources
      );

    config =
      configurations[
        configIndex
      ];

    if (!config) {
      throw new Error(
        `Invalid configuration index ${configIndex}`
      );
    }

    const candidateServers =
      uniqueServerCount(
        federationSources
      );

    const candidatePods =
      uniquePodCount(
        federationSources
      );

    console.log(
      `    Federation scale=${federationScale}`
    );

    console.log(
      `    Candidate servers=${candidateServers}`
    );

    console.log(
      `    Candidate pods=${candidatePods}`
    );

    console.log(
      `    Candidate RDF sources=${federationSources.length}`
    );

    if (
      candidatePods !==
      federationScale
    ) {
      throw new Error(
        `Expected ${federationScale} pods; detected ${candidatePods}`
      );
    }
  } catch (error) {
    if (config) {
      tryAppendFailureRow(
        outputFile,
        {
          config,
          repetition,
          federationScale,
          federationSources,
          discoveryMs,
          status:
            'SETUP_ERROR',
          error:
            formatError(error),
        }
      );
    }

    throw error;
  }

  /* ==========================================================
     QUERY INSTANTIATION
     ========================================================== */

  let queryText;

  try {
    const template =
      queryTemplate(
        config.queryId
      );

    queryText =
      config.role ===
      'researcher'
        ? instantiateCohortQuery(
            template,
            config.patientIds
          )
        : instantiatePatientQuery(
            template,
            config.patientIds[0]
          );
  } catch (error) {
    printFailure(
      'QUERY TEMPLATE ERROR',
      error
    );

    tryAppendFailureRow(
      outputFile,
      {
        config,
        repetition,
        federationScale,
        federationSources,
        discoveryMs,
        status:
          'QUERY_TEMPLATE_ERROR',
        error:
          formatError(error),
      }
    );

    process.exitCode = 1;
    return;
  }

  /* ==========================================================
     CREDENTIAL FILE
     ========================================================== */

  let credentials;

  try {
    const rawCredentials =
      JSON.parse(
        fs.readFileSync(
          CREDENTIAL_FILE,
          'utf8'
        )
      );

    credentials =
      normalizeCredentials(
        rawCredentials
      );

    if (
      !credentials.length
    ) {
      throw new Error(
        `No credentials found in ${CREDENTIAL_FILE}`
      );
    }
  } catch (error) {
    printFailure(
      'CREDENTIAL FILE ERROR',
      error
    );

    tryAppendFailureRow(
      outputFile,
      {
        config,
        repetition,
        federationScale,
        federationSources,
        discoveryMs,
        status:
          'CREDENTIAL_ERROR',
        error:
          formatError(error),
      }
    );

    process.exitCode = 1;
    return;
  }

  /* ==========================================================
     CREDENTIAL LOOKUP
     ========================================================== */

  let credential;

  try {
    credential =
      credentialFor(
        credentials,
        config.role,
        config.identity
      );
  } catch (error) {
    printFailure(
      'CREDENTIAL LOOKUP ERROR',
      error
    );

    tryAppendFailureRow(
      outputFile,
      {
        config,
        repetition,
        federationScale,
        federationSources,
        discoveryMs,
        status:
          'CREDENTIAL_ERROR',
        error:
          formatError(error),
      }
    );

    process.exitCode = 1;
    return;
  }

  /* ==========================================================
     AUTHENTICATION
     ========================================================== */

  session =
    new Session();

  try {
    console.log(
      `    Authenticating role=${config.role}, identity=${config.identity}`
    );

    const loginOptions =
      authFields(
        credential
      );

    await session.login(
      loginOptions
    );

    if (
      !session.info.isLoggedIn
    ) {
      throw new Error(
        'Authentication failed: session.info.isLoggedIn is false.'
      );
    }

    console.log(
      '    Authentication successful.'
    );
  } catch (error) {
    const message =
      formatError(error);

    console.error(
      '\n============================================================'
    );

    console.error(
      'AUTHENTICATION FAILED'
    );

    console.error(
      '============================================================'
    );

    console.error(
      `    Role: ${config.role}`
    );

    console.error(
      `    Identity: ${config.identity}`
    );

    console.error(
      `    Query: ${config.queryId}`
    );

    console.error(
      `    Scale: ${federationScale}`
    );

    console.error(
      `\n${message}`
    );

    if (
      message.includes(
        'invalid_client'
      )
    ) {
      console.error(
        '\nThe OIDC server rejected the saved client credentials.'
      );

      console.error(
        'Credential file:'
      );

      console.error(
        `    ${CREDENTIAL_FILE}`
      );

      console.error(
        'The client registration must exist in the storage used by the running CSS identity server.'
      );

      console.error(
        'Your project stores identities under identity-server/.'
      );

      console.error(
        'If CSS was started with -f ./identity, it is using a different directory.'
      );

      console.error(
        'Do not delete or regenerate credentials.'
      );
    }

    console.error(
      '============================================================\n'
    );

    tryAppendFailureRow(
      outputFile,
      {
        config,
        repetition,
        federationScale,
        federationSources,
        discoveryMs,
        status:
          'AUTH_ERROR',
        error:
          message,
      }
    );

    try {
      await session.logout();
    } catch {
      // Ignore cleanup errors.
    }

    process.exitCode = 1;
    return;
  }

  /* ==========================================================
     EXECUTION METRICS
     ========================================================== */

  cpuBefore =
    process.cpuUsage();

  peakMemory =
    memoryMB();

  memoryTimer =
    setInterval(
      () => {
        peakMemory = Math.max(
          peakMemory,
          memoryMB()
        );
      },
      100
    );

  memoryTimer.unref?.();

  const executionStart =
    performance.now();

  /* ==========================================================
     ACCESS CHECK
     ========================================================== */

  try {
    const authenticatedFetch =
      session.fetch.bind(
        session
      );

    accessFetch =
      makeCountingFetch(
        authenticatedFetch
      );

    console.log(
      `    Checking CSS access for all ${federationSources.length} candidate sources...`
    );

    const accessStart =
      performance.now();

    const selection =
      await selectAccessibleSources(
        federationSources,
        accessFetch
      );

    accessCheckMs =
      performance.now() -
      accessStart;

    accessible =
      selection.accessible;

    denied =
      selection.denied;
  } catch (error) {
    accessCheckMs =
      performance.now() -
      executionStart;

    if (memoryTimer) {
      clearInterval(
        memoryTimer
      );

      memoryTimer = null;
    }

    peakMemory = Math.max(
      peakMemory,
      memoryMB()
    );

    const cpuAfter =
      process.cpuUsage();

    const cpu =
      cpuDifferenceMs(
        cpuBefore,
        cpuAfter
      );

    printFailure(
      'ACCESS CHECK ERROR',
      error
    );

    tryAppendFailureRow(
      outputFile,
      {
        config,
        repetition,
        federationScale,
        federationSources,
        discoveryMs,
        accessCheckMs,
        accessFetch,
        accessible,
        denied,
        status:
          'ACCESS_ERROR',
        error:
          formatError(error),
        cpu,
        peakMemory,
      }
    );

    try {
      await session.logout();
    } catch {
      // Ignore cleanup errors.
    }

    process.exitCode = 1;
    return;
  }

  const sourceSelectionMs =
    discoveryMs +
    accessCheckMs;

  /* ==========================================================
     SOURCE COUNTS
     ========================================================== */

  const candidateServers =
    uniqueServerCount(
      federationSources
    );

  const candidatePods =
    uniquePodCount(
      federationSources
    );

  const selectedServers =
    uniqueServerCount(
      accessible
    );

  const selectedPods =
    uniquePodCount(
      accessible
    );

  const selectedSourceBytes =
    accessible.reduce(
      (sum, item) =>
        sum + item.sizeBytes,
      0
    );

  console.log(
    `    Accessible=${accessible.length}, denied=${denied.length}`
  );

  console.log(
    `    Selected servers=${selectedServers}`
  );

  console.log(
    `    Selected pods=${selectedPods}`
  );

  console.log(
    `    Access HTTP requests=${accessFetch.stats.requests}`
  );

  console.log(
    `    Comunica HTTP concurrency=${COMUNICA_HTTP_CONCURRENCY}`
  );

  console.log(
    `    Child V8 heap ceiling=${CHILD_HEAP_MB} MB`
  );

  console.log(
    '    Comunica sources=plain authenticated URLs'
  );

  console.log(
    `    Running Comunica over ALL ${accessible.length} accessible source URLs...`
  );

  /* ==========================================================
     COMUNICA EXECUTION
     ========================================================== */

  let comunica;

  try {
    comunica =
      await runComunica({
        queryText,
        accessibleSources:
          accessible,
        session,
      });
  } catch (error) {
    comunica = {
      resultCount: 0,
      resultHash: '',
      runtimeMs: 0,
      http:
        newHttpStats(),
      status:
        'COMUNICA_FATAL_ERROR',
      error:
        formatError(error),
    };
  }

  const totalMs =
    discoveryMs +
    (
      performance.now() -
      executionStart
    );

  /* ==========================================================
     CPU AND MEMORY END
     ========================================================== */

  if (memoryTimer) {
    clearInterval(
      memoryTimer
    );

    memoryTimer = null;
  }

  peakMemory = Math.max(
    peakMemory,
    memoryMB()
  );

  const cpuAfter =
    process.cpuUsage();

  const cpu =
    cpuDifferenceMs(
      cpuBefore,
      cpuAfter
    );

  /* ==========================================================
     HTTP TOTALS
     ========================================================== */

  const totalHttpRequests =
    accessFetch.stats.requests +
    comunica.http.requests;

  const totalHttpOk =
    accessFetch.stats.ok +
    comunica.http.ok;

  const totalHttpError =
    accessFetch.stats.error +
    comunica.http.error;

  const uniqueUrls =
    new Set([
      ...accessFetch.stats.uniqueUrls,
      ...comunica.http.uniqueUrls,
    ]);

  const rdfBytesTransferred =
    accessFetch.stats.bytes +
    comunica.http.bytes;

  /* ==========================================================
     CSV RESULT ROW
     ========================================================== */

  try {
    appendCsv(
      outputFile,
      {
        timestamp:
          new Date().toISOString(),

        approach:
          'baseline',

        repetition,
        federationScale,

        role:
          config.role,

        identity:
          config.identity,

        accessGroup:
          config.accessGroup,

        query:
          config.queryId,

        patientCount:
          config.patientIds.length,

        candidateServers,
        selectedServers,

        candidatePods,
        selectedPods,

        candidateSources:
          federationSources.length,

        accessibleOriginalSources:
          accessible.length,

        deniedOriginalSources:
          denied.length,

        selectedSources:
          accessible.length,

        selectedSourceBytes,

        selectedSourceMB:
          bytesToMB(
            selectedSourceBytes
          ).toFixed(6),

        rdfBytesTransferred,

        rdfMBTransferred:
          bytesToMB(
            rdfBytesTransferred
          ).toFixed(6),

        sourceDiscoveryMs:
          discoveryMs.toFixed(3),

        accessCheckMs:
          accessCheckMs.toFixed(3),

        sourceSelectionMs:
          sourceSelectionMs.toFixed(3),

        comunicaMs:
          comunica.runtimeMs.toFixed(3),

        totalMs:
          totalMs.toFixed(3),

        accessCheckHttpRequests:
          accessFetch.stats.requests,

        queryHttpRequests:
          comunica.http.requests,

        httpRequests:
          totalHttpRequests,

        httpOk:
          totalHttpOk,

        httpError:
          totalHttpError,

        uniqueHttpUrls:
          uniqueUrls.size,

        results:
          comunica.resultCount,

        resultHash:
          comunica.resultHash,

        status:
          comunica.status,

        error:
          comunica.error,

        cpuUserMs:
          cpu.user.toFixed(3),

        cpuSystemMs:
          cpu.system.toFixed(3),

        peakMemoryMB:
          peakMemory.toFixed(3),
      }
    );
  } catch (error) {
    printFailure(
      'CHILD CSV WRITE FAILED',
      error
    );

    throw error;
  }

  console.log(
    `    ${comunica.status}` +
    ` | scale=${federationScale}` +
    ` | results=${comunica.resultCount}` +
    ` | sources=${accessible.length}/${federationSources.length}` +
    ` | accessHTTP=${accessFetch.stats.requests}` +
    ` | queryHTTP=${comunica.http.requests}` +
    ` | queryHTTPError=${comunica.http.error}` +
    ` | totalHTTP=${totalHttpRequests}` +
    ` | total=${totalMs.toFixed(2)} ms` +
    ` | peak=${peakMemory.toFixed(1)} MB`
  );

  if (
    comunica.error
  ) {
    console.error(
      `    Error:\n${comunica.error}`
    );
  }

  /* ==========================================================
     SESSION CLEANUP
     ========================================================== */

  try {
    await session.logout();
  } catch (error) {
    console.error(
      `    Logout warning: ${formatError(error)}`
    );
  }

  process.exitCode =
    comunica.status === 'PASS'
      ? 0
      : 1;
}

/* ============================================================
   SPAWN ONE EXECUTION
   ============================================================ */

async function spawnExecution(
  index,
  repetition,
  federationScale
) {
  return await new Promise(
    resolve => {
      let settled = false;

      const child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${CHILD_HEAP_MB}`,

          SCRIPT_FILE,

          'baseline',

          '--scale',
          String(
            federationScale
          ),

          '--child-index',
          String(index),

          '--child-repetition',
          String(repetition),
        ],
        {
          cwd: HERE,

          stdio:
            'inherit',

          env: {
            ...process.env,
          },
        }
      );

      function finish(code) {
        if (settled) {
          return;
        }

        settled = true;

        resolve(code);
      }

      child.once(
        'error',
        error => {
          console.error(
            `    CHILD SPAWN ERROR: ${formatError(error)}`
          );

          finish(1);
        }
      );

      child.once(
        'exit',
        (code, signal) => {
          if (signal) {
            console.error(
              `    CHILD TERMINATED BY SIGNAL ${signal}`
            );

            finish(1);
            return;
          }

          finish(
            code ?? 1
          );
        }
      );
    }
  );
}

/* ============================================================
   LATEST CSV ROW

   Fixed parser handles multiline errors.
   ============================================================ */

function latestExecutionRow(
  outputFile
) {
  if (
    !fs.existsSync(
      outputFile
    )
  ) {
    return null;
  }

  const rows = parseCsv(
    fs.readFileSync(
      outputFile,
      'utf8'
    )
  );

  return rows.length
    ? rows[
        rows.length - 1
      ]
    : null;
}

function printLatestExecutionStatus(
  outputFile
) {
  const row =
    latestExecutionRow(
      outputFile
    );

  if (!row) {
    console.error(
      '    No CSV execution row was written.'
    );

    return null;
  }

  console.log(
    `    Latest CSV status: ${row.status}`
  );

  if (
    row.error &&
    row.status !== 'PASS'
  ) {
    console.error(
      `    Latest CSV error:\n${row.error}`
    );
  }

  return row;
}

/* ============================================================
   PARENT
   ============================================================ */

async function runParent() {
  const approach = (
    process.argv[2] ??
    'baseline'
  ).toLowerCase();

  if (
    approach !== 'baseline'
  ) {
    throw new Error(
      'This script implements the baseline only.'
    );
  }

  const federationScale =
    getFederationScale();

  const outputFile =
    outputFileForScale(
      federationScale
    );

  const repetitions =
    getRepetitionCount();

  const singleMode =
    process.argv.includes(
      '--single'
    );

  console.log(
    '============================================================'
  );

  console.log(
    'ICDE BASELINE — FEDERATION SCALABILITY EXPERIMENT'
  );

  console.log(
    '============================================================'
  );

  console.log(
    `Project root: ${ROOT}`
  );

  console.log(
    `Script directory: ${HERE}`
  );

  console.log(
    `Credential file: ${CREDENTIAL_FILE}`
  );

  console.log(
    `Selected federation scale: ${federationScale} pods`
  );

  console.log(
    `Nested scales: ${FEDERATION_SCALES.join(' -> ')}`
  );

  console.log(
    `Output CSV: ${outputFile}`
  );

  console.log(
    '\nFederation selection: fixed VM pod selections'
  );

  console.log(
    `Federation selection file: ${FEDERATION_SELECTION_FILE}`
  );

  console.log(
    '\nEach query independently performs:'
  );

  console.log(
    '  fixed nested federation-scale selection'
  );

  console.log(
    '  -> authentication'
  );

  console.log(
    '  -> CSS access checking of ALL candidate RDF resources'
  );

  console.log(
    '  -> ALL accessible original RDF URLs'
  );

  console.log(
    '  -> authenticated Comunica Solid execution'
  );

  console.log(
    '  -> one CSV result row'
  );

  console.log(
    '\nNo metadata source selection.'
  );

  console.log(
    'No QUERY_TYPES filtering.'
  );

  console.log(
    'No patient-ID source filtering.'
  );

  console.log(
    'No Q12 source shortcut.'
  );

  console.log(
    'No accessibility caching between queries.'
  );

  console.log(
    'No reuse of access-check RDF bodies.'
  );

  console.log(
    'No type:file.'
  );

  console.log(
    'No compositefile.'
  );

  console.log(
    'No HTTP retries.'
  );

  console.log(
    'Access checking remains sequential.'
  );

  console.log(
    `Comunica HTTP concurrency limit: ${COMUNICA_HTTP_CONCURRENCY}`
  );

  console.log(
    `Child V8 heap ceiling: ${CHILD_HEAP_MB} MB`
  );

  console.log(
    'Client IDs and secrets are never printed.'
  );

  if (singleMode) {
    console.log(
      'SINGLE MODE: exactly configuration 1 will execute.'
    );
  }

  /* ==========================================================
     DISCOVERY
     ========================================================== */

  const fullFederationSources =
    discoverFederationSources();

  if (
    !fullFederationSources.length
  ) {
    throw new Error(
      'No RDF sources discovered.'
    );
  }

  const fullPodCount =
    uniquePodCount(
      fullFederationSources
    );

  if (
    fullPodCount !==
    EXPECTED_PODS
  ) {
    throw new Error(
      `Pod detection is wrong: expected ${EXPECTED_PODS}, detected ${fullPodCount}.`
    );
  }

  const configurations =
    buildWorkload(
      fullFederationSources
    );

  const federationSources =
    selectFederationScale(
      fullFederationSources,
      federationScale
    );

  const detectedScalePods =
    uniquePodCount(
      federationSources
    );

  console.log(
    `\nFull federation pods detected: ${fullPodCount}`
  );

  console.log(
    `Full federation RDF sources: ${fullFederationSources.length}`
  );

  console.log(
    `Selected federation pods: ${detectedScalePods}`
  );

  console.log(
    `Selected federation servers: ${uniqueServerCount(federationSources)}`
  );

  console.log(
    `Selected federation RDF sources: ${federationSources.length}`
  );

  console.log(
    `Execution configurations: ${configurations.length}`
  );

  console.log(
    `Repetitions: ${repetitions}`
  );

  console.log(
    `Total planned executions: ${
      singleMode
        ? 1
        : configurations.length *
          repetitions
    }`
  );

  if (
    detectedScalePods !==
    federationScale
  ) {
    throw new Error(
      `Federation construction is wrong: expected ${federationScale}, detected ${detectedScalePods}.`
    );
  }

  if (
    process.argv.includes(
      '--plan'
    )
  ) {
    console.log(
      '\nPLAN ONLY — no HTTP requests made.'
    );

    return;
  }

  ensureOutputSchema(
    outputFile
  );

  /* ==========================================================
     SINGLE MODE
     ========================================================== */

  if (singleMode) {
    const index = 0;
    const repetition = 1;

    const config =
      configurations[index];

    console.log(
      `\nOutput: ${outputFile}`
    );

    console.log(
      '\n================ SINGLE EXECUTION ================'
    );

    console.log(
      '\n------------------------------------------------------------'
    );

    console.log(
      `[1/${EXPECTED_CONFIGURATIONS}] ` +
      `${config.role} ` +
      `${config.queryId} ` +
      `${config.identity}`
    );

    console.log(
      `    Federation scale=${federationScale}`
    );

    console.log(
      `    Starting fresh Node process with ${CHILD_HEAP_MB} MB heap ceiling...`
    );

    const exitCode =
      await spawnExecution(
        index,
        repetition,
        federationScale
      );

    const row =
      printLatestExecutionStatus(
        outputFile
      );

    console.log(
      '\n============================================================'
    );

    if (
      exitCode === 0 &&
      row?.status === 'PASS'
    ) {
      console.log(
        'SINGLE EXECUTION PASSED'
      );
    } else {
      console.error(
        'SINGLE EXECUTION FAILED'
      );

      console.error(
        `Child exit code: ${exitCode}`
      );

      process.exitCode = 1;
    }

    console.log(
      'No further configurations were started.'
    );

    console.log(
      '============================================================'
    );

    return;
  }

  /* ==========================================================
     FULL WORKLOAD
     ========================================================== */

  const completed =
    completedExecutions(
      outputFile
    );

  console.log(
    `\nOutput: ${outputFile}`
  );

  console.log(
    `Already completed PASS executions at scale ${federationScale}: ${completed.size}`
  );

  for (
    let repetition = 1;
    repetition <= repetitions;
    repetition++
  ) {
    console.log(
      `\n================ REPETITION ${repetition}/${repetitions} ================`
    );

    for (
      let index = 0;
      index < configurations.length;
      index++
    ) {
      const config =
        configurations[index];

      const key =
        executionKey(
          config,
          repetition
        );

      if (
        completed.has(key)
      ) {
        console.log(
          `[${index + 1}/${EXPECTED_CONFIGURATIONS}] SKIP PASS ` +
          `${config.role} ${config.queryId} ${config.identity}`
        );

        continue;
      }

      console.log(
        '\n------------------------------------------------------------'
      );

      console.log(
        `[${index + 1}/${EXPECTED_CONFIGURATIONS}] ` +
        `${config.role} ` +
        `${config.queryId} ` +
        `${config.identity}`
      );

      console.log(
        `    Federation scale=${federationScale}`
      );

      console.log(
        `    Starting fresh Node process with ${CHILD_HEAP_MB} MB heap ceiling...`
      );

      const exitCode =
        await spawnExecution(
          index,
          repetition,
          federationScale
        );

      const row =
        printLatestExecutionStatus(
          outputFile
        );

      if (
        exitCode !== 0
      ) {
        console.error(
          `    Execution process failed with exit code ${exitCode}.`
        );

        if (
          STOP_ON_AUTH_FAILURE &&
          (
            row?.status ===
              'AUTH_ERROR' ||
            row?.status ===
              'CREDENTIAL_ERROR'
          )
        ) {
          console.error(
            '\n============================================================'
          );

          console.error(
            'BASELINE STOPPED: AUTHENTICATION/CREDENTIAL FAILURE'
          );

          console.error(
            '============================================================'
          );

          console.error(
            'The remaining configurations were NOT started.'
          );

          process.exitCode = 1;
          return;
        }

        console.error(
          '    Continuing to the next execution.'
        );
      }

      const nowCompleted =
        completedExecutions(
          outputFile
        );

      if (
        nowCompleted.has(
          key
        )
      ) {
        completed.add(
          key
        );
      }
    }
  }

  console.log(
    '\n============================================================'
  );

  console.log(
    `BASELINE SCALE ${federationScale} RUN COMPLETE`
  );

  console.log(
    `Saved: ${outputFile}`
  );

  console.log(
    '============================================================'
  );
}

/* ============================================================
   PROCESS-LEVEL ERROR HANDLING
   ============================================================ */

process.on(
  'unhandledRejection',
  reason => {
    console.error(
      '\nUNHANDLED PROMISE REJECTION'
    );

    console.error(
      formatError(reason)
    );

    process.exitCode = 1;
  }
);

process.on(
  'uncaughtException',
  error => {
    console.error(
      '\nUNCAUGHT EXCEPTION'
    );

    console.error(
      formatError(error)
    );

    process.exitCode = 1;
  }
);

/* ============================================================
   ENTRY POINT
   ============================================================ */

async function main() {
  if (
    process.argv.includes(
      '--child-index'
    )
  ) {
    try {
      await runChild();
    } catch (error) {
      console.error(
        '\nCHILD EXECUTION FAILED'
      );

      console.error(
        formatError(error)
      );

      process.exitCode = 1;
    }

    return;
  }

  try {
    await runParent();
  } catch (error) {
    console.error(
      '\nBASELINE RUNNER FAILED'
    );

    console.error(
      formatError(error)
    );

    process.exitCode = 1;
  }
}

await main();