import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

import { Parser as SparqlParser } from 'sparqljs';
import { Parser as N3Parser } from 'n3';

import { QueryEngine } from '@comunica/query-sparql-solid';
import { Session } from '@inrupt/solid-client-authn-node';



const SCRIPT_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT_FILE);

function findProjectRoot(startDirectory) {
  let current = startDirectory;

  while (true) {
    if (
      fs.existsSync(path.join(current, 'identity_credentials')) &&
      fs.existsSync(path.join(current, 'experiments'))
    ) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(
        'Cannot locate ICDE-Synthea project root.'
      );
    }

    current = parent;
  }
}

const ROOT = findProjectRoot(HERE);
const EXPERIMENTS = path.join(ROOT, 'experiments');

const QUERY_DIR_CANDIDATES = [
  path.join(HERE, 'queries'),
  path.join(
    ROOT,
    'experiments',
    'overlay-query-layer',
    'queries'
  ),
  path.join(
    ROOT,
    'overlay-query-layer',
    'queries'
  ),
];

function findQueryDirectory() {
  for (const candidate of QUERY_DIR_CANDIDATES) {
    if (
      fs.existsSync(
        path.join(
          candidate,
          'Q01_patient_active_conditions.rq'
        )
      )
    ) {
      return candidate;
    }
  }

  throw new Error(
    'Cannot locate SPARQL query directory.'
  );
}

const QUERY_DIR = findQueryDirectory();

const CREDENTIAL_FILE = path.join(
  ROOT,
  'identity_credentials',
  'solid_identities.json'
);

const FEDERATION_SELECTION_CANDIDATES = [
  path.join(
    HERE,
    'federation_scale_selections.json'
  ),
  path.join(
    ROOT,
    'experiments',
    'overlay-query-layer',
    'federation_scale_selections.json'
  ),
  path.join(
    ROOT,
    'overlay-query-layer',
    'federation_scale_selections.json'
  ),
];

function findFederationSelectionFile() {
  for (const candidate of FEDERATION_SELECTION_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Cannot locate federation_scale_selections.json.'
  );
}

const FEDERATION_SELECTION_FILE =
  findFederationSelectionFile();

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

const OVERLAY_CANDIDATES = [
  path.join(
    ROOT,
    'overlay-query-layer',
    'ESPRESSO-overlay-indexes'
  ),
  path.join(
    ROOT,
    'experiments',
    'overlay-query-layer',
    'ESPRESSO-overlay-indexes'
  ),
];

function findOverlayDirectory() {
  for (const candidate of OVERLAY_CANDIDATES) {
    if (
      fs.existsSync(
        path.join(candidate, 'public.json')
      )
    ) {
      return candidate;
    }
  }

  throw new Error(
    'Cannot find ESPRESSO overlay metadata directory.'
  );
}

const OVERLAY_INDEX_DIR = findOverlayDirectory();

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

const PROGRESS_INTERVAL_MS = 5000;

const PSO_MATCH_MODE =
  process.env.PSO_MATCH_MODE || 'any';

if (!['any', 'all'].includes(PSO_MATCH_MODE)) {
  throw new Error(
    'PSO_MATCH_MODE must be "any" or "all".'
  );
}

const UNION_DEFAULT_GRAPH = true;

/* ============================================================
   SERVERS

   Overlay identifiers:
       S1, S2, S3, S4

   Actual HTTP servers:
       localhost:3001 ... localhost:3004

   Local directories:
       experiments/S1 ... experiments/S4

   PSO provenance graph identifiers:
       server1, server2, server3, server4

   These are distinct identifiers.
   ============================================================ */

const SERVERS = {
  S1: 3001,
  S2: 3002,
  S3: 3003,
  S4: 3004,
};

function serverBaseUrl(server) {
  const port = SERVERS[server];

  if (!port) {
    throw new Error(
      `Unknown server: ${server}`
    );
  }

  return `http://localhost:${port}/`;
}

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
   CSV COLUMNS
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

  'webId',
  'psoMatchMode',

  'triplePatterns',
  'fixedPredicates',

  'overlayIndexMs',
  'serverMetaIndexMs',
  'podIndexLookupMs',

  'candidateIndexEntries',
  'resolvedCandidateEntries',

  'matchedIndexFiles',
  'selectedIndexFiles',

  'candidateCategories',
  'selectedCategories',

  'overlayIndexesRead',
  'serverIndexesRead',
  'podIndexesRead',

  'overlayIndexBytesRead',
  'serverIndexBytesRead',
  'podIndexBytesRead',

  'selectedIndexBytes',
  'selectedIndexMB',

  'queryCpuUserMs',
  'queryCpuSystemMs',

  'cpuTotalMs',
  'cpuUtilizationPercent',

  'initialMemoryMB',
  'finalMemoryMB',
  'peakHeapUsedMB',

  'queryHttpOk',
  'queryHttpError',
  'queryUniqueHttpUrls',

  'httpResponseBytes',
  'httpResponseMB',

  'authenticationMs',
  'queryPreparationMs',
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

function round(value, digits = 3) {
  return Number(value || 0).toFixed(digits);
}

function formatError(error) {
  return error?.stack ||
    String(error?.message || error);
}

function printStep(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function unique(values) {
  return [...new Set(values)];
}

function readJson(file) {
  return JSON.parse(
    fs.readFileSync(file, 'utf8')
  );
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

function webidFilename(webid) {
  if (webid === 'public') {
    return 'public.json';
  }

  return `webid_${sha256(webid)}.json`;
}

function outputFileForScale(scale) {
  return path.join(
    HERE,
    `experiment_case1_scale_${scale}.csv`
  );
}

/* ============================================================
   CSV PARSER AND WRITER
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
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (char === ',' && !quoted) {
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

      if (record.some(value => value !== '')) {
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

  if (field !== '' || record.length) {
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

    header.forEach((column, index) => {
      row[column] = values[index] ?? '';
    });

    return row;
  });
}

function readCsv(file) {
  if (!fs.existsSync(file)) {
    fatal(`Missing CSV: ${file}`);
  }

  return parseCsv(
    fs.readFileSync(file, 'utf8')
  );
}

function ensureOutputSchema(outputFile) {
  const expected = OUTPUT_COLUMNS.join(',');

  if (!fs.existsSync(outputFile)) {
    fs.writeFileSync(
      outputFile,
      expected + '\n',
      'utf8'
    );

    return;
  }

  const fd = fs.openSync(outputFile, 'r');

  try {
    const buffer = Buffer.alloc(16384);

    const bytesRead = fs.readSync(
      fd,
      buffer,
      0,
      buffer.length,
      0
    );

    const text = buffer
      .subarray(0, bytesRead)
      .toString('utf8');

    const header = text.split(/\r?\n/, 1)[0];

    if (header !== expected) {
      fatal(
        `Existing CSV has a different schema: ${outputFile}`
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

function appendCsv(outputFile, row) {
  ensureOutputSchema(outputFile);

  const line = OUTPUT_COLUMNS
    .map(column => csvEscape(row[column]))
    .join(',') + '\n';

  fs.appendFileSync(
    outputFile,
    line,
    'utf8'
  );
}

/* ============================================================
   COMMAND LINE
   ============================================================ */

function getFederationScale() {
  const index = process.argv.indexOf('--scale');

  if (index === -1) {
    fatal(
      `Missing --scale. Allowed: ${FEDERATION_SCALES.join(', ')}`
    );
  }

  const scale = Number(process.argv[index + 1]);

  if (!FEDERATION_SCALES.includes(scale)) {
    fatal(
      `Invalid federation scale: ${scale}`
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

  const repetitions = Number(
    process.argv[index + 1]
  );

  if (
    !Number.isInteger(repetitions) ||
    repetitions < 1
  ) {
    fatal(
      '--repetitions must be a positive integer.'
    );
  }

  return repetitions;
}

/* ============================================================
   CREDENTIALS
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
    if (Array.isArray(raw?.[key])) {
      return raw[key];
    }
  }

  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter(
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

function credentialFor(credentials, role, sourceId) {
  const targetRole = role.toLowerCase();
  const targetId = sourceId.toLowerCase();

  const candidates = new Set([
    targetId,
    `${targetRole}_${targetId}`,
  ]);

  const credential = credentials.find(item =>
    roleOf(item) === targetRole &&
    candidates.has(
      sourceIdOf(item).toLowerCase()
    )
  );

  if (!credential) {
    fatal(
      `Credential not found: role=${role}, sourceId=${sourceId}`
    );
  }

  return credential;
}

function credentialWebId(credential) {
  const webid =
    credential.webId ??
    credential.webid ??
    credential.web_id ??
    credential.solidWebId ??
    credential.solid_webid;

  if (!webid) {
    return null;
  }

  if (
    typeof webid !== 'string' ||
    !/^https?:\/\//.test(webid)
  ) {
    fatal(
      `Invalid credential WebID: ${sourceIdOf(credential)}`
    );
  }

  return webid;
}

function normalizeIssuer(value) {
  const url = new URL(value);

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

  const issuer =
    credential.oidcIssuer ??
    credential.oidc_issuer ??
    credential.cssBaseUrl ??
    credential.css_base_url ??
    DEFAULT_OIDC_ISSUER;

  if (!clientId || !clientSecret) {
    fatal(
      `Missing client credentials: ${sourceIdOf(credential)}`
    );
  }

  return {
    clientId,
    clientSecret,
    oidcIssuer: normalizeIssuer(issuer),
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

    const entries = fs.readdirSync(
      current,
      { withFileTypes: true }
    );

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        [
          '.internal',
          'espressoindex',
          'ESPRESSO-pod',
        ].includes(entry.name)
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
   SOURCE URLS
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

  return serverBaseUrl(server) + relative;
}

/* ============================================================
   POD IDENTIFICATION
   ============================================================ */

function inferPod(server, file) {
  const relative = path.relative(
    path.join(EXPERIMENTS, server),
    file
  );

  const parts = relative.split(path.sep);

  for (let i = 0; i < parts.length; i++) {
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

  return '';
}

function podKey(item) {
  return `${item.server}/${item.pod}`;
}

/* ============================================================
   FEDERATION DISCOVERY
   ============================================================ */

function discoverFederationSources() {
  const sources = [];

  for (const server of Object.keys(SERVERS)) {
    const root = path.join(
      EXPERIMENTS,
      server
    );

    safeWalk(root, file => {
      if (!file.endsWith('.nq')) {
        return;
      }

      const pod = inferPod(server, file);

      if (!pod) {
        return;
      }

      sources.push({
        server,
        pod,
        file,
        url: fileToUrl(server, file),
        sizeBytes: fs.statSync(file).size,
      });
    });
  }

  sources.sort(
    (a, b) => a.url.localeCompare(b.url)
  );

  return sources;
}

function uniqueServerCount(items) {
  return new Set(
    items
      .map(item => item.server)
      .filter(Boolean)
  ).size;
}

function uniquePodCount(items) {
  return new Set(
    items
      .filter(item => item.server && item.pod)
      .map(podKey)
  ).size;
}

/* ============================================================
   FIXED FEDERATION SELECTIONS
   ============================================================ */

function loadFederationSelections(fullSources) {
  const selections = readJson(
    FEDERATION_SELECTION_FILE
  );

  const actualPodKeys = new Set(
    fullSources.map(podKey)
  );

  if (actualPodKeys.size !== EXPECTED_PODS) {
    fatal(
      `Expected ${EXPECTED_PODS} pods; found ${actualPodKeys.size}`
    );
  }

  for (const scale of FEDERATION_SCALES) {
    const selected = selections[String(scale)];

    if (
      !Array.isArray(selected) ||
      selected.length !== scale ||
      new Set(selected).size !== scale
    ) {
      fatal(
        `Invalid federation selection for scale ${scale}`
      );
    }

    for (const key of selected) {
      if (!actualPodKeys.has(key)) {
        fatal(
          `Selected federation pod not found: ${key}`
        );
      }
    }
  }

  for (
    let i = 0;
    i < FEDERATION_SCALES.length - 1;
    i++
  ) {
    const smaller =
      selections[String(FEDERATION_SCALES[i])];

    const larger = new Set(
      selections[
        String(FEDERATION_SCALES[i + 1])
      ]
    );

    for (const key of smaller) {
      if (!larger.has(key)) {
        fatal(
          'Federation scale selections are not nested.'
        );
      }
    }
  }

  return selections;
}

function selectFederationScale(
  fullSources,
  scale,
  selections
) {
  const selectedPods = new Set(
    selections[String(scale)]
  );

  const sources = fullSources.filter(
    item => selectedPods.has(podKey(item))
  );

  if (uniquePodCount(sources) !== scale) {
    fatal(
      `Federation selection failed for scale ${scale}`
    );
  }

  return {
    sources,
    podKeys: selectedPods,
  };
}

/* ============================================================
   PATIENT WORKLOAD
   ============================================================ */

function selectedPatients() {
  const patients = new Map();

  for (const row of readCsv(PATIENT_FILE)) {
    const id =
      row.patient_id ??
      row.source_id;

    if (!id) {
      continue;
    }

    patients.set(
      id.toLowerCase(),
      row.distribution_group ??
      row.distributionGroup ??
      ''
    );
  }

  if (patients.size !== 20) {
    fatal(
      `Expected 20 selected patients; found ${patients.size}`
    );
  }

  return patients;
}

/* ============================================================
   PRACTITIONER WORKLOAD
   ============================================================ */

function practitionerAccess() {
  const map = new Map();

  for (const row of readCsv(PRACTITIONER_FILE)) {
    const practitioner =
      row.practitioner_id?.toLowerCase();

    const patient =
      row.patient_id?.toLowerCase();

    if (!practitioner || !patient) {
      continue;
    }

    if (!map.has(practitioner)) {
      map.set(practitioner, new Set());
    }

    map.get(practitioner).add(patient);
  }

  if (map.size !== 20) {
    fatal(
      `Expected 20 practitioners; found ${map.size}`
    );
  }

  return map;
}

/* ============================================================
   RESEARCHER COHORTS
   ============================================================ */

function loadCohort(name) {
  return new Set(
    readCsv(COHORT_FILES[name])
      .map(row =>
        row.patient_id?.toLowerCase()
      )
      .filter(Boolean)
  );
}

/* ============================================================
   WEARABLE PATIENTS
   ============================================================ */

function wearablePatients(sources) {
  const patients = new Set();

  for (const item of sources) {
    const normalized = item.file
      .split(path.sep)
      .join('/');

    if (
      !normalized.includes('/wearable_data/')
    ) {
      continue;
    }

    const match = normalized.match(
      /patient_([0-9a-fA-F-]{36})/
    );

    if (match) {
      patients.add(
        match[1].toLowerCase()
      );
    }
  }

  return patients;
}

/* ============================================================
   QUERY TEMPLATES
   ============================================================ */

function queryTemplate(queryId) {
  const filename = QUERY_FILES[queryId];

  if (!filename) {
    fatal(
      `Unknown query: ${queryId}`
    );
  }

  const file = path.join(
    QUERY_DIR,
    filename
  );

  if (!fs.existsSync(file)) {
    fatal(
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
  return template.replaceAll(
    '{{PATIENT_ID}}',
    patientId
  );
}

function instantiateCohortQuery(
  template,
  patientIds
) {
  const values = patientIds
    .map(patientUri)
    .join('\n    ');

  return template.replaceAll(
    '{{COHORT_PATIENT_URIS}}',
    values
  );
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

  // 20 patients × 4 queries = 80.
  for (const [
    patientId,
    distributionGroup,
  ] of patients.entries()) {
    for (const queryId of [
      'Q01',
      'Q02',
      'Q03',
      'Q04',
    ]) {
      configs.push({
        role: 'patient',
        identity: patientId,
        queryId,
        patientIds: [patientId],
        accessGroup: distributionGroup,
      });
    }
  }

  // 20 practitioners × 4 queries = 80.
  for (const [
    practitionerId,
    patientSet,
  ] of practitioners.entries()) {
    const authorisedPatients = [
      ...patientSet,
    ].sort();

    if (!authorisedPatients.length) {
      fatal(
        `Practitioner has no authorised patients: ${practitionerId}`
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

    for (const queryId of [
      'Q05',
      'Q06',
      'Q07',
      'Q08',
    ]) {
      configs.push({
        role: 'practitioner',
        identity: practitionerId,
        queryId,
        patientIds: [patientId],
        authorisedPatientIds:
          authorisedPatients,
        accessGroup,
      });
    }
  }

  // 3 researchers × 4 queries = 12.
  for (const cohortName of [
    'R1',
    'R2',
    'R3',
  ]) {
    const clinicalPatients = [
      ...cohorts[cohortName],
    ].sort();

    for (const queryId of [
      'Q09',
      'Q10',
      'Q11',
    ]) {
      configs.push({
        role: 'researcher',
        identity: cohortName,
        queryId,
        patientIds: clinicalPatients,
        accessGroup: cohortName,
      });
    }

    const wearableCohort =
      clinicalPatients.filter(
        id => wearableSet.has(id)
      );

    configs.push({
      role: 'researcher',
      identity: cohortName,
      queryId: 'Q12',
      patientIds: wearableCohort,
      accessGroup: cohortName,
    });
  }

  return configs;
}

function buildWorkload(fullSources) {
  const configurations = makeConfigurations({
    patients: selectedPatients(),

    practitioners: practitionerAccess(),

    cohorts: {
      R1: loadCohort('R1'),
      R2: loadCohort('R2'),
      R3: loadCohort('R3'),
    },

    wearableSet: wearablePatients(
      fullSources
    ),
  });

  if (
    configurations.length !==
    EXPECTED_CONFIGURATIONS
  ) {
    fatal(
      `Expected 172 configurations; found ${configurations.length}`
    );
  }

  return configurations;
}

/* ============================================================
   SPARQL PATTERN EXTRACTION
   ============================================================ */

function isVariable(term) {
  if (!term) {
    return false;
  }

  if (typeof term === 'string') {
    return term.startsWith('?');
  }

  return term.termType === 'Variable';
}

function isNamedNode(term) {
  if (!term) {
    return false;
  }

  if (typeof term === 'string') {
    return /^https?:\/\//.test(term);
  }

  return term.termType === 'NamedNode';
}

function termValue(term) {
  if (!term) {
    return null;
  }

  if (typeof term === 'string') {
    return term.replace(/^<|>$/g, '');
  }

  return term.value ?? null;
}

function isSimpleTerm(term) {
  if (!term) {
    return false;
  }

  if (typeof term === 'string') {
    return true;
  }

  return [
    'NamedNode',
    'BlankNode',
    'Literal',
    'Variable',
  ].includes(term.termType);
}

function extractTriplePatterns(queryText) {
  const parser = new SparqlParser();
  const parsed = parser.parse(queryText);
  const patterns = [];

  function walk(items) {
    if (!Array.isArray(items)) {
      return;
    }

    for (const item of items) {
      if (
        !item ||
        typeof item !== 'object'
      ) {
        continue;
      }

      if (
        item.type === 'bgp' &&
        Array.isArray(item.triples)
      ) {
        for (const triple of item.triples) {
          patterns.push({
            subject: triple.subject,
            predicate: triple.predicate,
            object: triple.object,

            subjectIsVariable:
              isVariable(triple.subject),

            predicateIsVariable:
              isVariable(triple.predicate),

            objectIsVariable:
              isVariable(triple.object),

            simple:
              isSimpleTerm(triple.subject) &&
              isSimpleTerm(triple.predicate) &&
              isSimpleTerm(triple.object),
          });
        }
      }

      if (Array.isArray(item.patterns)) {
        walk(item.patterns);
      }

      if (Array.isArray(item.where)) {
        walk(item.where);
      }
    }
  }

  walk(parsed.where);

  return patterns;
}

function extractFixedPredicates(patterns) {
  return unique(
    patterns
      .filter(pattern =>
        isNamedNode(pattern.predicate) &&
        !pattern.predicateIsVariable
      )
      .map(pattern =>
        termValue(pattern.predicate)
      )
  );
}

/* ============================================================
   METADATA PATHS
   ============================================================ */

function overlayIndexPath(webid) {
  return path.join(
    OVERLAY_INDEX_DIR,
    webidFilename(webid)
  );
}

function serverIndexPath(server, webid) {
  return path.join(
    EXPERIMENTS,
    server,
    'ESPRESSO-pod',
    'metaindex',
    webidFilename(webid)
  );
}

/* ============================================================
   INDEX METRICS
   ============================================================ */

function newIndexStats() {
  return {
    overlayFiles: new Set(),
    serverFiles: new Set(),
    podFiles: new Set(),

    overlayBytes: 0,
    serverBytes: 0,
    podBytes: 0,
  };
}

function readMeasuredJson(
  file,
  filesSet,
  stats,
  bytesField
) {
  if (!fs.existsSync(file)) {
    return null;
  }

  if (!filesSet.has(file)) {
    filesSet.add(file);

    stats[bytesField] +=
      fs.statSync(file).size;
  }

  return readJson(file);
}

/* ============================================================
   METADATA SCHEMA NORMALIZATION

   Accepts:

   {
     "predicates": {
       "predicateIRI": [...]
     }
   }

   Also accepts a direct predicate map.

   Empty predicate maps are valid.
   ============================================================ */

function predicateMapFromMetadata(data, file) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    fatal(
      `Invalid metadata JSON object: ${file}`
    );
  }

  const map =
    data.predicates &&
    typeof data.predicates === 'object' &&
    !Array.isArray(data.predicates)
      ? data.predicates
      : data;

  const predicates = Object.entries(map).filter(
    ([key, value]) =>
      /^https?:\/\//.test(key) &&
      Array.isArray(value)
  );

  if (!predicates.length) {
    if (Object.keys(map).length === 0) {
      return {};
    }

    fatal(
      `No valid predicate mapping found in metadata: ${file}`
    );
  }

  return Object.fromEntries(predicates);
}

/* ============================================================
   URL RESOLUTION
   ============================================================ */

function serverFromUrl(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  for (const [
    server,
    port,
  ] of Object.entries(SERVERS)) {
    if (
      ['localhost', '127.0.0.1'].includes(
        parsed.hostname
      ) &&
      parsed.port === String(port)
    ) {
      return server;
    }
  }

  return null;
}

function urlToLocalFile(url) {
  const server = serverFromUrl(url);

  if (!server) {
    return null;
  }

  const parsed = new URL(url);

  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

  const serverRoot = path.resolve(
    EXPERIMENTS,
    server
  );

  const resolved = path.resolve(
    serverRoot,
    ...segments
  );

  if (
    resolved !== serverRoot &&
    !resolved.startsWith(
      serverRoot + path.sep
    )
  ) {
    fatal(
      `Unsafe index URL path: ${url}`
    );
  }

  return {
    server,
    file: resolved,
  };
}

function podFromUrl(url) {
  const resolved = urlToLocalFile(url);

  if (!resolved) {
    return null;
  }

  return inferPod(
    resolved.server,
    resolved.file
  );
}

function podKeyFromUrl(url) {
  const server = serverFromUrl(url);
  const pod = podFromUrl(url);

  if (!server || !pod) {
    return null;
  }

  return `${server}/${pod}`;
}

function categoryFromUrl(url) {
  const resolved = urlToLocalFile(url);

  if (!resolved) {
    return '';
  }

  const relative = path.relative(
    path.join(
      EXPERIMENTS,
      resolved.server
    ),
    resolved.file
  );

  const parts = relative.split(path.sep);

  const index = parts.indexOf(
    'facility_pods'
  );

  if (index !== -1) {
    return parts[index + 1] || '';
  }

  if (parts.includes('patient_pods')) {
    return 'patient';
  }

  return '';
}

/* ============================================================
   LEVEL 1 — OVERLAY SELECTION

   UPDATED FOR NEW OVERLAY FORMAT

   Example:

   {
     "level": "overlay",
     "name": "webid_<hash>",
     "webid": "http://localhost:3000/...#me",
     "predicates": {
       "http://example.org/predicate": [
         "S1",
         "S2"
       ]
     }
   }

   Private overlay -> private server metadata.
   Public overlay  -> public server metadata.

   Old URL-based overlay entries remain supported.
   ============================================================ */

function selectServersFromOverlay({
  webid,
  predicates,
  allowedServers,
  stats,
}) {
  const overlayFiles = [
    {
      file: overlayIndexPath(webid),
      visibility: 'private',
      metadataName: webidFilename(webid),
    },
    {
      file: overlayIndexPath('public'),
      visibility: 'public',
      metadataName: 'public.json',
    },
  ];

  const selected = new Map();

  for (const overlay of overlayFiles) {
    const data = readMeasuredJson(
      overlay.file,
      stats.overlayFiles,
      stats,
      'overlayBytes'
    );

    if (!data) {
      fatal(
        `Required overlay index missing: ${overlay.file}`
      );
    }

    const predicateMap =
      predicateMapFromMetadata(
        data,
        overlay.file
      );

    /*
     * Ensure private metadata belongs to the
     * authenticated identity, if WebID is present.
     */
    if (
      overlay.visibility === 'private' &&
      data.webid &&
      data.webid !== webid
    ) {
      fatal(
        `Overlay WebID mismatch in ${overlay.file}\n` +
        `Expected: ${webid}\n` +
        `Actual: ${data.webid}`
      );
    }

    for (const predicate of predicates) {
      const references =
        predicateMap[predicate] || [];

      for (const reference of references) {
        if (typeof reference !== 'string') {
          fatal(
            `Invalid overlay server reference in ${overlay.file}`
          );
        }

        let server = null;
        let metadataUrl = null;

        /*
         * NEW FORMAT:
         * "S1", "S2", "S3", "S4"
         */
        if (
          Object.prototype.hasOwnProperty.call(
            SERVERS,
            reference
          )
        ) {
          server = reference;

          metadataUrl =
            serverBaseUrl(server) +
            'ESPRESSO-pod/metaindex/' +
            overlay.metadataName;
        }

        /*
         * BACKWARD COMPATIBILITY:
         * Existing metadata URL references.
         */
        else {
          server = serverFromUrl(reference);

          if (server) {
            metadataUrl = reference;
          }
        }

        if (!server || !metadataUrl) {
          fatal(
            `Unknown overlay server reference: ${reference}\n` +
            `File: ${overlay.file}`
          );
        }

        if (!allowedServers.has(server)) {
          continue;
        }

        const key = [
          server,
          overlay.visibility,
          metadataUrl,
        ].join('|');

        selected.set(key, {
          server,
          metadataUrl,
          visibility: overlay.visibility,
        });
      }
    }
  }

  return [...selected.values()];
}

/* ============================================================
   LEVEL 2 — SERVER METADATA SELECTION

   The server metadata contains actual pod URLs
   and actual PSO URLs.

   These URLs are used directly.

   No attempt is made to derive source URLs from
   PSO provenance graph names such as "server1".
   ============================================================ */

function selectPodIndexesFromServers({
  selectedServerMetadata,
  predicates,
  selectedPodKeys,
  stats,
}) {
  const entries = [];
  const seen = new Set();

  for (const metadata of selectedServerMetadata) {
    const resolved = urlToLocalFile(
      metadata.metadataUrl
    );

    if (
      !resolved ||
      resolved.server !== metadata.server
    ) {
      fatal(
        `Invalid server metadata URL: ${metadata.metadataUrl}`
      );
    }

    const file = resolved.file;

    const data = readMeasuredJson(
      file,
      stats.serverFiles,
      stats,
      'serverBytes'
    );

    if (!data) {
      fatal(
        `Required server metadata missing: ${file}`
      );
    }

    const predicateMap =
      predicateMapFromMetadata(
        data,
        file
      );

    for (const predicate of predicates) {
      const references =
        predicateMap[predicate] || [];

      for (const reference of references) {
        if (
          !reference ||
          typeof reference !== 'object' ||
          Array.isArray(reference)
        ) {
          fatal(
            `Invalid PSO reference in ${file}`
          );
        }

        const podUrl = reference.pod;
        const psoUrl = reference.pso;

        if (
          typeof podUrl !== 'string' ||
          typeof psoUrl !== 'string' ||
          !podUrl ||
          !psoUrl
        ) {
          fatal(
            `PSO reference missing pod/pso in ${file}`
          );
        }

        const key = podKeyFromUrl(
          podUrl
        );

        if (
          !key ||
          !selectedPodKeys.has(key)
        ) {
          continue;
        }

        if (
          serverFromUrl(psoUrl) !==
          metadata.server
        ) {
          continue;
        }

        const psoPodKey =
          podKeyFromUrl(psoUrl);

        if (psoPodKey !== key) {
          continue;
        }

        const psoName = path.basename(
          new URL(psoUrl).pathname
        );

        if (
          !psoName.endsWith('.nq') ||
          !new URL(psoUrl).pathname.includes(
            '/espressoindex/'
          )
        ) {
          continue;
        }

        const expectedPrivateName =
          path.basename(
            new URL(
              metadata.metadataUrl
            ).pathname
          ).replace(/\.json$/, '.nq');

        if (
          metadata.visibility === 'private' &&
          psoName !== expectedPrivateName
        ) {
          continue;
        }

        if (
          metadata.visibility === 'public' &&
          !psoName.startsWith('public-')
        ) {
          continue;
        }

        const entryKey = [
          predicate,
          psoUrl,
        ].join('|');

        if (seen.has(entryKey)) {
          continue;
        }

        seen.add(entryKey);

        entries.push({
          predicate,
          server: metadata.server,

          pod: key
            .split('/')
            .slice(1)
            .join('/'),

          podKey: key,
          podUrl,
          psoUrl,

          category:
            categoryFromUrl(psoUrl),

          visibility:
            metadata.visibility,
        });
      }
    }
  }

  return entries;
}

/* ============================================================
   RDF TERM COMPARISON

   Only RDF subject, predicate, and object are
   compared for PSO selection.

   The graph component is provenance and is
   intentionally not used for file resolution.
   ============================================================ */

function rdfTermMatches(actual, expected) {
  if (!expected) {
    return true;
  }

  if (isVariable(expected)) {
    return true;
  }

  if (typeof expected === 'string') {
    return (
      actual.value === termValue(expected)
    );
  }

  if (
    expected.termType === 'NamedNode' ||
    expected.termType === 'BlankNode'
  ) {
    return (
      actual.termType === expected.termType &&
      actual.value === expected.value
    );
  }

  if (expected.termType === 'Literal') {
    return (
      actual.termType === 'Literal' &&
      actual.value === expected.value &&
      actual.language ===
        (expected.language || '') &&
      actual.datatype?.value ===
        expected.datatype?.value
    );
  }

  return false;
}

function quadMatchesPattern(quad, pattern) {
  if (!pattern.simple) {
    return true;
  }

  return (
    rdfTermMatches(
      quad.subject,
      pattern.subject
    ) &&
    rdfTermMatches(
      quad.predicate,
      pattern.predicate
    ) &&
    rdfTermMatches(
      quad.object,
      pattern.object
    )
  );
}

/* ============================================================
   STREAMING N-QUADS MATCHING
   ============================================================ */

async function indexMatchesPatterns(
  file,
  patterns,
  stats
) {
  if (!fs.existsSync(file)) {
    fatal(
      `Pod PSO index missing: ${file}`
    );
  }

  if (!stats.podFiles.has(file)) {
    stats.podFiles.add(file);

    stats.podBytes +=
      fs.statSync(file).size;
  }

  const relevantPatterns = patterns.filter(
    pattern =>
      pattern.predicate &&
      !pattern.predicateIsVariable
  );

  if (!relevantPatterns.length) {
    return true;
  }

  const matched = new Array(
    relevantPatterns.length
  ).fill(false);

  const stream = fs.createReadStream(file, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024,
  });

  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const parser = new N3Parser({
    format: 'N-Quads',
  });

  let lineNumber = 0;
  let quadCount = 0;

  try {
    for await (const line of lines) {
      lineNumber++;

      const clean = line.trim();

      if (
        !clean ||
        clean.startsWith('#')
      ) {
        continue;
      }

      let quads;

      try {
        quads = parser.parse(
          clean + '\n'
        );
      } catch (error) {
        fatal(
          [
            'Invalid N-Quads in PSO index.',
            `File: ${file}`,
            `Line: ${lineNumber}`,
            `Error: ${error.message}`,
          ].join('\n')
        );
      }

      for (const quad of quads) {
        quadCount++;

        for (
          let i = 0;
          i < relevantPatterns.length;
          i++
        ) {
          if (matched[i]) {
            continue;
          }

          if (
            quadMatchesPattern(
              quad,
              relevantPatterns[i]
            )
          ) {
            matched[i] = true;
          }
        }

        if (
          PSO_MATCH_MODE === 'any' &&
          matched.some(Boolean)
        ) {
          return true;
        }

        if (
          PSO_MATCH_MODE === 'all' &&
          matched.every(Boolean)
        ) {
          return true;
        }
      }

      if (
        lineNumber % 1000000 === 0
      ) {
        console.log(
          [
            '[PSO SCAN]',
            `file=${path.basename(file)}`,
            `lines=${lineNumber}`,
            `quads=${quadCount}`,
            `matched=${matched.filter(Boolean).length}`,
            `required=${relevantPatterns.length}`,
            `rss=${memoryMB().toFixed(1)}MB`,
          ].join(' | ')
        );
      }
    }

    return PSO_MATCH_MODE === 'all'
      ? matched.every(Boolean)
      : matched.some(Boolean);
  } finally {
    lines.close();
    stream.destroy();
  }
}

/* ============================================================
   LEVEL 3 — SELECT MATCHING PSO INDEXES
   ============================================================ */

async function selectMatchingPsoIndexes({
  candidateEntries,
  patterns,
  stats,
}) {
  const byUrl = new Map();

  for (const entry of candidateEntries) {
    if (!byUrl.has(entry.psoUrl)) {
      byUrl.set(entry.psoUrl, entry);
    }
  }

  const selected = [];

  const total = byUrl.size;
  let examined = 0;

  for (const entry of byUrl.values()) {
    examined++;

    const resolved = urlToLocalFile(
      entry.psoUrl
    );

    if (!resolved) {
      fatal(
        `Cannot resolve PSO URL: ${entry.psoUrl}`
      );
    }

    const file = resolved.file;

    if (!fs.existsSync(file)) {
      fatal(
        `PSO index does not exist: ${file}`
      );
    }

    const sizeBytes =
      fs.statSync(file).size;

    console.log(
      [
        `[PSO ${examined}/${total}]`,
        path.basename(file),
        `size=${round(bytesToMB(sizeBytes), 2)}MB`,
      ].join(' | ')
    );

    const matches =
      await indexMatchesPatterns(
        file,
        patterns,
        stats
      );

    if (matches) {
      selected.push({
        ...entry,
        file,
        sizeBytes,
      });

      console.log(
        `[PSO] MATCH → ${entry.psoUrl}`
      );
    } else {
      console.log(
        `[PSO] NO MATCH → ${entry.psoUrl}`
      );
    }
  }

  return selected;
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

function makeBoundedCountingFetch(
  baseFetch,
  limit
) {
  const stats = newHttpStats();

  let active = 0;
  const queue = [];

  async function acquire() {
    if (active < limit) {
      active++;
      return;
    }

    await new Promise(resolve => {
      queue.push(resolve);
    });

    active++;
  }

  function release() {
    active--;

    const next = queue.shift();

    if (next) {
      next();
    }
  }

  const countingFetch = async (...args) => {
    await acquire();

    const url = requestUrl(args);

    stats.requests++;
    stats.uniqueUrls.add(url);

    try {
      const response =
        await baseFetch(...args);

      if (response.ok) {
        stats.ok++;
      } else {
        stats.error++;
      }

      const length = Number(
        response.headers?.get?.(
          'content-length'
        )
      );

      if (
        Number.isFinite(length) &&
        length > 0
      ) {
        stats.bytes += length;
      }

      return response;
    } catch (error) {
      stats.error++;
      throw error;
    } finally {
      release();
    }
  };

  countingFetch.stats = stats;

  return countingFetch;
}

/* ============================================================
   RESULT HASH
   ============================================================ */

function bindingCanonicalString(binding) {
  const entries = [];

  for (const [variable, term] of binding) {
    entries.push(
      `${variable.value}=${term.termType}:${term.value}`
    );
  }

  entries.sort();

  return entries.join('|');
}

function resultSetHash(rows) {
  const sorted = [...rows].sort();

  const hash = crypto.createHash(
    'sha256'
  );

  for (const row of sorted) {
    hash.update(row);
    hash.update('\n');
  }

  return hash.digest('hex');
}

/* ============================================================
   CPU AND MEMORY
   ============================================================ */

function memoryMB() {
  return bytesToMB(
    process.memoryUsage().rss
  );
}

function heapUsedMB() {
  return bytesToMB(
    process.memoryUsage().heapUsed
  );
}

function cpuDifferenceMs(before, after) {
  return {
    user:
      (after.user - before.user) / 1000,

    system:
      (after.system - before.system) / 1000,
  };
}

function startResourceMonitor() {
  const initialMemoryMB = memoryMB();

  let peakMemoryMB = initialMemoryMB;
  let peakHeapUsedMB = heapUsedMB();

  const cpuBefore = process.cpuUsage();
  const start = performance.now();

  const timer = setInterval(() => {
    peakMemoryMB = Math.max(
      peakMemoryMB,
      memoryMB()
    );

    peakHeapUsedMB = Math.max(
      peakHeapUsedMB,
      heapUsedMB()
    );
  }, 100);

  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);

      const finalMemoryMB = memoryMB();

      peakMemoryMB = Math.max(
        peakMemoryMB,
        finalMemoryMB
      );

      peakHeapUsedMB = Math.max(
        peakHeapUsedMB,
        heapUsedMB()
      );

      const maxRSS =
        process.resourceUsage().maxRSS;

      const processPeakMB =
        process.platform === 'darwin'
          ? bytesToMB(maxRSS)
          : maxRSS / 1024;

      peakMemoryMB = Math.max(
        peakMemoryMB,
        processPeakMB
      );

      const cpuAfter = process.cpuUsage();

      const cpu = cpuDifferenceMs(
        cpuBefore,
        cpuAfter
      );

      const elapsedMs =
        performance.now() - start;

      return {
        cpuUserMs: cpu.user,
        cpuSystemMs: cpu.system,

        cpuTotalMs:
          cpu.user + cpu.system,

        cpuUtilizationPercent:
          elapsedMs > 0
            ? (
                (cpu.user + cpu.system) /
                elapsedMs
              ) * 100
            : 0,

        initialMemoryMB,
        finalMemoryMB,
        peakMemoryMB,
        peakHeapUsedMB,
      };
    },
  };
}

/* ============================================================
   LIVE COMUNICA STATUS
   ============================================================ */

function startComunicaHeartbeat({
  getState,
  intervalMs = PROGRESS_INTERVAL_MS,
}) {
  const start = performance.now();

  const timer = setInterval(() => {
    const state = getState();

    const elapsedSeconds =
      (performance.now() - start) / 1000;

    console.log(
      [
        '[COMUNICA] RUNNING',
        `elapsed=${elapsedSeconds.toFixed(1)}s`,
        `phase=${state.phase}`,
        `results=${state.results}`,
        `http=${state.http.requests}`,
        `ok=${state.http.ok}`,
        `errors=${state.http.error}`,
        `uniqueUrls=${state.http.uniqueUrls.size}`,
        `rss=${memoryMB().toFixed(1)}MB`,
      ].join(' | ')
    );
  }, intervalMs);

  return () => {
    clearInterval(timer);

    console.log(
      '[COMUNICA] Heartbeat stopped.'
    );
  };
}

/* ============================================================
   COMUNICA — SELECTED PSO URLS ONLY
   ============================================================ */

async function runComunica({
  queryText,
  selectedIndexes,
  session,
}) {
  const urls = unique(
    selectedIndexes.map(
      item => item.psoUrl
    )
  );

  const emptyHttp = newHttpStats();

  if (!urls.length) {
    console.error(
      '[COMUNICA] No PSO sources selected.'
    );

    return {
      resultCount: 0,
      resultHash: '',
      runtimeMs: 0,

      http: emptyHttp,

      status: 'NO_SOURCES_SELECTED',

      error:
        'No PSO sources selected; Comunica was not executed.',

      cpuUserMs: 0,
      cpuSystemMs: 0,
    };
  }

  printStep(
    'COMUNICA — INDEX-ONLY EXECUTION'
  );

  console.log(
    `[COMUNICA] Selected PSO sources: ${urls.length}`
  );

  console.log(
    `[COMUNICA] HTTP concurrency: ${COMUNICA_HTTP_CONCURRENCY}`
  );

  console.log(
    '[COMUNICA] Original RDF sources: 0'
  );

  const originalSessionFetch =
    session.fetch.bind(session);

  const queryFetch =
    makeBoundedCountingFetch(
      originalSessionFetch,
      COMUNICA_HTTP_CONCURRENCY
    );

  session.fetch = queryFetch;

  const engine = new QueryEngine();

  const start = performance.now();
  const cpuBefore = process.cpuUsage();

  let resultCount = 0;
  let phase = 'initializing';

  const canonicalRows = [];

  const stopHeartbeat =
    startComunicaHeartbeat({
      getState: () => ({
        phase,
        results: resultCount,
        http: queryFetch.stats,
      }),
    });

  try {
    console.log(
      '[COMUNICA] Calling queryBindings...'
    );

    const stream =
      await engine.queryBindings(
        queryText,
        {
          sources: urls,

          '@comunica/actor-http-inrupt-solid-client-authn:session':
            session,

          httpRetryCount: 0,

          unionDefaultGraph:
            UNION_DEFAULT_GRAPH,
        }
      );

    phase = 'reading-bindings';

    console.log(
      '[COMUNICA] Binding stream initialized.'
    );

    for await (const binding of stream) {
      resultCount++;

      canonicalRows.push(
        bindingCanonicalString(binding)
      );

      if (
        resultCount === 1 ||
        resultCount % 100 === 0
      ) {
        console.log(
          `[COMUNICA] Results received: ${resultCount}`
        );
      }
    }

    phase = 'completed';

    const cpuAfter = process.cpuUsage();

    const cpu = cpuDifferenceMs(
      cpuBefore,
      cpuAfter
    );

    return {
      resultCount,

      resultHash:
        resultSetHash(canonicalRows),

      runtimeMs:
        performance.now() - start,

      http: queryFetch.stats,

      status: 'PASS',
      error: '',

      cpuUserMs: cpu.user,
      cpuSystemMs: cpu.system,
    };
  } catch (error) {
    phase = 'error';

    const cpuAfter = process.cpuUsage();

    const cpu = cpuDifferenceMs(
      cpuBefore,
      cpuAfter
    );

    return {
      resultCount,
      resultHash: '',

      runtimeMs:
        performance.now() - start,

      http: queryFetch.stats,

      status: 'QUERY_ERROR',
      error: formatError(error),

      cpuUserMs: cpu.user,
      cpuSystemMs: cpu.system,
    };
  } finally {
    stopHeartbeat();

    session.fetch =
      originalSessionFetch;

    console.log(
      `[COMUNICA] Final phase: ${phase}`
    );

    console.log(
      `[COMUNICA] Total results received: ${resultCount}`
    );

    console.log(
      `[COMUNICA] HTTP requests: ${queryFetch.stats.requests}`
    );

    console.log(
      `[COMUNICA] HTTP errors: ${queryFetch.stats.error}`
    );
  }
}

/* ============================================================
   EXECUTION KEYS AND RESUME
   ============================================================ */

function executionKey(config, repetition) {
  return [
    config.role,
    config.identity,
    config.queryId,
    config.accessGroup,
    repetition,
  ].join('|');
}

function completedExecutions(outputFile) {
  const completed = new Set();

  if (!fs.existsSync(outputFile)) {
    return completed;
  }

  ensureOutputSchema(outputFile);

  const rows = parseCsv(
    fs.readFileSync(
      outputFile,
      'utf8'
    )
  );

  for (const row of rows) {
    if (row.status !== 'PASS') {
      continue;
    }

    if (
      Number(row.selectedIndexFiles || 0) === 0 ||
      Number(row.comunicaMs || 0) <= 0
    ) {
      continue;
    }

    completed.add([
      row.role,
      row.identity,
      row.query,
      row.accessGroup,
      row.repetition,
    ].join('|'));
  }

  return completed;
}

/* ============================================================
   DEFAULT CSV ROW
   ============================================================ */

function defaultMetrics({
  config,
  repetition,
  scale,
  webid = '',
}) {
  const row = {};

  for (const column of OUTPUT_COLUMNS) {
    row[column] = '';
  }

  return {
    ...row,

    timestamp:
      new Date().toISOString(),

    approach: 'case1-index-only',

    repetition,
    federationScale: scale,

    role: config.role,
    identity: config.identity,
    accessGroup: config.accessGroup,
    query: config.queryId,

    patientCount:
      config.patientIds.length,

    webId: webid,

    psoMatchMode:
      PSO_MATCH_MODE,

    status: 'SETUP_ERROR',
    error: '',
  };
}

/* ============================================================
   CHILD EXECUTION
   ============================================================ */

async function runChild() {
  const scale = getFederationScale();

  const indexPosition =
    process.argv.indexOf('--child-index');

  const repetitionPosition =
    process.argv.indexOf(
      '--child-repetition'
    );

  const configIndex = Number(
    process.argv[indexPosition + 1]
  );

  const repetition = Number(
    process.argv[repetitionPosition + 1]
  );

  if (
    !Number.isInteger(configIndex) ||
    configIndex < 0 ||
    !Number.isInteger(repetition) ||
    repetition < 1
  ) {
    fatal(
      'Invalid child execution arguments.'
    );
  }

  const outputFile =
    outputFileForScale(scale);

  let config = null;
  let session = null;
  let monitor = null;
  let metrics = null;

  const totalStart = performance.now();

  let discoveryMs = 0;
  let authenticationMs = 0;
  let queryPreparationMs = 0;

  let overlayIndexMs = 0;
  let serverMetaIndexMs = 0;
  let podIndexLookupMs = 0;

  let sourceSelectionMs = 0;

  let selectedIndexes = [];
  let candidateEntries = [];

  const indexStats = newIndexStats();

  let monitorResult = null;

  let stage = 'SETUP';

  try {
    /* ========================================================
       FEDERATION DISCOVERY
       ======================================================== */

    printStep(
      'CASE 1 — FEDERATION DISCOVERY'
    );

    const discoveryStart =
      performance.now();

    const fullSources =
      discoverFederationSources();

    const selections =
      loadFederationSelections(
        fullSources
      );

    const federation =
      selectFederationScale(
        fullSources,
        scale,
        selections
      );

    const configurations =
      buildWorkload(
        fullSources
      );

    config =
      configurations[configIndex];

    if (!config) {
      fatal(
        `Invalid configuration index: ${configIndex}`
      );
    }

    discoveryMs =
      performance.now() - discoveryStart;

    metrics = defaultMetrics({
      config,
      repetition,
      scale,
    });

    metrics.candidateServers =
      uniqueServerCount(
        federation.sources
      );

    metrics.candidatePods =
      uniquePodCount(
        federation.sources
      );

    metrics.candidateSources =
      federation.sources.length;

    console.log(
      `Scale: ${scale}`
    );

    console.log(
      `Candidate servers: ${metrics.candidateServers}`
    );

    console.log(
      `Candidate pods: ${metrics.candidatePods}`
    );

    console.log(
      `Candidate original RDF files: ${metrics.candidateSources}`
    );

    /* ========================================================
       QUERY PREPARATION
       ======================================================== */

    stage = 'QUERY_PREPARATION';

    printStep(
      'QUERY PREPARATION'
    );

    const preparationStart =
      performance.now();

    const template = queryTemplate(
      config.queryId
    );

    const queryText =
      config.role === 'researcher'
        ? instantiateCohortQuery(
            template,
            config.patientIds
          )
        : instantiatePatientQuery(
            template,
            config.patientIds[0]
          );

    const patterns =
      extractTriplePatterns(
        queryText
      );

    const predicates =
      extractFixedPredicates(
        patterns
      );

    queryPreparationMs =
      performance.now() -
      preparationStart;

    metrics.triplePatterns =
      patterns.length;

    metrics.fixedPredicates =
      predicates.length;

    console.log(
      `Query: ${config.queryId}`
    );

    console.log(
      `Triple patterns: ${patterns.length}`
    );

    console.log(
      `Fixed predicates: ${predicates.length}`
    );

    if (!predicates.length) {
      fatal(
        'No fixed predicates available for ESPRESSO selection.'
      );
    }

    /* ========================================================
       CREDENTIAL LOOKUP
       ======================================================== */

    stage = 'CREDENTIAL_LOOKUP';

    const credentials =
      normalizeCredentials(
        readJson(CREDENTIAL_FILE)
      );

    const credential =
      credentialFor(
        credentials,
        config.role,
        config.identity
      );

    const expectedWebId =
      credentialWebId(
        credential
      );

    /* ========================================================
       AUTHENTICATION
       ======================================================== */

    stage = 'AUTHENTICATION';

    printStep(
      'AUTHENTICATION'
    );

    session = new Session();

    const authStart =
      performance.now();

    await session.login(
      authFields(credential)
    );

    authenticationMs =
      performance.now() - authStart;

    if (!session.info.isLoggedIn) {
      fatal(
        'Authentication failed.'
      );
    }

    const webid =
      session.info.webId ||
      expectedWebId;

    if (!webid) {
      fatal(
        'Authenticated WebID is unavailable.'
      );
    }

    if (
      expectedWebId &&
      session.info.webId &&
      expectedWebId !== session.info.webId
    ) {
      fatal(
        `Authenticated WebID mismatch: expected ${expectedWebId}, got ${session.info.webId}`
      );
    }

    metrics.webId = webid;

    console.log(
      `Authenticated WebID: ${webid}`
    );

    console.log(
      `Authentication time: ${round(authenticationMs)} ms`
    );

    /* ========================================================
       RESOURCE MONITOR
       ======================================================== */

    monitor = startResourceMonitor();

    const selectionStart =
      performance.now();

    /* ========================================================
       LEVEL 1 — OVERLAY
       ======================================================== */

    stage = 'OVERLAY_SELECTION';

    printStep(
      'OVERLAY-LEVEL SELECTION'
    );

    const allowedServers = new Set(
      federation.sources.map(
        item => item.server
      )
    );

    const overlayStart =
      performance.now();

    const selectedServerMetadata =
      selectServersFromOverlay({
        webid,
        predicates,
        allowedServers,
        stats: indexStats,
      });

    overlayIndexMs =
      performance.now() - overlayStart;

    console.log(
      `Overlay metadata entries: ${selectedServerMetadata.length}`
    );

    for (const metadata of selectedServerMetadata) {
      console.log(
        [
          '[OVERLAY]',
          `server=${metadata.server}`,
          `visibility=${metadata.visibility}`,
          `metadata=${metadata.metadataUrl}`,
        ].join(' | ')
      );
    }

    console.log(
      `Overlay lookup: ${round(overlayIndexMs)} ms`
    );

    /* ========================================================
       LEVEL 2 — SERVER METADATA
       ======================================================== */

    stage = 'SERVER_SELECTION';

    printStep(
      'SERVER-LEVEL SELECTION'
    );

    const serverStart =
      performance.now();

    candidateEntries =
      selectPodIndexesFromServers({
        selectedServerMetadata,
        predicates,

        selectedPodKeys:
          federation.podKeys,

        stats: indexStats,
      });

    serverMetaIndexMs =
      performance.now() - serverStart;

    console.log(
      `Candidate PSO entries: ${candidateEntries.length}`
    );

    console.log(
      `Server metadata lookup: ${round(serverMetaIndexMs)} ms`
    );

    /* ========================================================
       LEVEL 3 — POD PSO MATCHING
       ======================================================== */

    stage = 'POD_PSO_MATCHING';

    printStep(
      'POD-LEVEL PSO MATCHING'
    );

    const podStart =
      performance.now();

    selectedIndexes =
      await selectMatchingPsoIndexes({
        candidateEntries,
        patterns,
        stats: indexStats,
      });

    podIndexLookupMs =
      performance.now() - podStart;

    sourceSelectionMs =
      performance.now() -
      selectionStart;

    console.log(
      `PSO indexes examined: ${indexStats.podFiles.size}`
    );

    console.log(
      `PSO indexes selected: ${selectedIndexes.length}`
    );

    console.log(
      `Pod lookup: ${round(podIndexLookupMs)} ms`
    );

    console.log(
      `Total index source selection: ${round(sourceSelectionMs)} ms`
    );

    /* ========================================================
       SOURCE COUNTS
       ======================================================== */

    const selectedPsoUrls =
      unique(
        selectedIndexes.map(
          item => item.psoUrl
        )
      );

    const selectedIndexBytes =
      selectedIndexes.reduce(
        (sum, item) =>
          sum + item.sizeBytes,
        0
      );

    metrics.selectedServers =
      new Set(
        selectedIndexes.map(
          item => item.server
        )
      ).size;

    metrics.selectedPods =
      new Set(
        selectedIndexes.map(
          item => item.podKey
        )
      ).size;

    metrics.selectedSources =
      selectedPsoUrls.length;

    metrics.selectedSourceBytes =
      selectedIndexBytes;

    metrics.selectedSourceMB =
      round(
        bytesToMB(selectedIndexBytes),
        6
      );

    metrics.selectedIndexBytes =
      selectedIndexBytes;

    metrics.selectedIndexMB =
      round(
        bytesToMB(selectedIndexBytes),
        6
      );

    metrics.candidateIndexEntries =
      candidateEntries.length;

    metrics.resolvedCandidateEntries =
      candidateEntries.length;

    metrics.matchedIndexFiles =
      selectedPsoUrls.length;

    metrics.selectedIndexFiles =
      selectedPsoUrls.length;

    metrics.candidateCategories =
      new Set(
        candidateEntries
          .map(item => item.category)
          .filter(Boolean)
      ).size;

    metrics.selectedCategories =
      new Set(
        selectedIndexes
          .map(item => item.category)
          .filter(Boolean)
      ).size;

    metrics.overlayIndexesRead =
      indexStats.overlayFiles.size;

    metrics.serverIndexesRead =
      indexStats.serverFiles.size;

    metrics.podIndexesRead =
      indexStats.podFiles.size;

    metrics.overlayIndexBytesRead =
      indexStats.overlayBytes;

    metrics.serverIndexBytesRead =
      indexStats.serverBytes;

    metrics.podIndexBytesRead =
      indexStats.podBytes;

    metrics.sourceDiscoveryMs =
      round(discoveryMs);

    metrics.overlayIndexMs =
      round(overlayIndexMs);

    metrics.serverMetaIndexMs =
      round(serverMetaIndexMs);

    metrics.podIndexLookupMs =
      round(podIndexLookupMs);

    metrics.sourceSelectionMs =
      round(
        discoveryMs +
        sourceSelectionMs
      );

    metrics.accessCheckMs =
      '0.000';

    metrics.accessibleOriginalSources =
      'NA';

    metrics.deniedOriginalSources =
      'NA';

    /* ========================================================
       COMUNICA
       ======================================================== */

    stage = 'COMUNICA';

    const comunica =
      await runComunica({
        queryText,
        selectedIndexes,
        session,
      });

    /* ========================================================
       RESOURCE METRICS
       ======================================================== */

    monitorResult = monitor.stop();
    monitor = null;

    const totalMs =
      performance.now() - totalStart;

    /* ========================================================
       CSV METRICS
       ======================================================== */

    metrics.comunicaMs =
      round(comunica.runtimeMs);

    metrics.totalMs =
      round(totalMs);

    metrics.accessCheckHttpRequests = 0;

    metrics.queryHttpRequests =
      comunica.http.requests;

    metrics.httpRequests =
      comunica.http.requests;

    metrics.httpOk =
      comunica.http.ok;

    metrics.httpError =
      comunica.http.error;

    metrics.uniqueHttpUrls =
      comunica.http.uniqueUrls.size;

    metrics.queryHttpOk =
      comunica.http.ok;

    metrics.queryHttpError =
      comunica.http.error;

    metrics.queryUniqueHttpUrls =
      comunica.http.uniqueUrls.size;

    metrics.rdfBytesTransferred =
      comunica.http.bytes;

    metrics.rdfMBTransferred =
      round(
        bytesToMB(comunica.http.bytes),
        6
      );

    metrics.httpResponseBytes =
      comunica.http.bytes;

    metrics.httpResponseMB =
      round(
        bytesToMB(comunica.http.bytes),
        6
      );

    metrics.results =
      comunica.resultCount;

    metrics.resultHash =
      comunica.resultHash;

    metrics.status =
      comunica.status;

    metrics.error =
      comunica.error;

    metrics.cpuUserMs =
      round(
        monitorResult.cpuUserMs
      );

    metrics.cpuSystemMs =
      round(
        monitorResult.cpuSystemMs
      );

    metrics.peakMemoryMB =
      round(
        monitorResult.peakMemoryMB
      );

    metrics.queryCpuUserMs =
      round(
        comunica.cpuUserMs
      );

    metrics.queryCpuSystemMs =
      round(
        comunica.cpuSystemMs
      );

    metrics.cpuTotalMs =
      round(
        monitorResult.cpuTotalMs
      );

    metrics.cpuUtilizationPercent =
      round(
        monitorResult.cpuUtilizationPercent
      );

    metrics.initialMemoryMB =
      round(
        monitorResult.initialMemoryMB
      );

    metrics.finalMemoryMB =
      round(
        monitorResult.finalMemoryMB
      );

    metrics.peakHeapUsedMB =
      round(
        monitorResult.peakHeapUsedMB
      );

    metrics.authenticationMs =
      round(authenticationMs);

    metrics.queryPreparationMs =
      round(queryPreparationMs);

    appendCsv(
      outputFile,
      metrics
    );

    /* ========================================================
       SUMMARY
       ======================================================== */

    printStep(
      'CASE 1 EXECUTION SUMMARY'
    );

    console.log(
      `Status: ${metrics.status}`
    );

    console.log(
      `Scale: ${scale}`
    );

    console.log(
      `Query: ${config.queryId}`
    );

    console.log(
      `Role: ${config.role}`
    );

    console.log(
      `Selected servers: ${metrics.selectedServers}`
    );

    console.log(
      `Selected pods: ${metrics.selectedPods}`
    );

    console.log(
      `Selected PSO indexes: ${metrics.selectedIndexFiles}`
    );

    console.log(
      `Results: ${metrics.results}`
    );

    console.log(
      `Overlay time: ${metrics.overlayIndexMs} ms`
    );

    console.log(
      `Server time: ${metrics.serverMetaIndexMs} ms`
    );

    console.log(
      `Pod time: ${metrics.podIndexLookupMs} ms`
    );

    console.log(
      `Comunica time: ${metrics.comunicaMs} ms`
    );

    console.log(
      `Total time: ${metrics.totalMs} ms`
    );

    console.log(
      `CPU user: ${metrics.cpuUserMs} ms`
    );

    console.log(
      `CPU system: ${metrics.cpuSystemMs} ms`
    );

    console.log(
      `Peak RSS: ${metrics.peakMemoryMB} MB`
    );

    console.log(
      `Peak heap: ${metrics.peakHeapUsedMB} MB`
    );

    console.log(
      `HTTP requests: ${metrics.httpRequests}`
    );

    console.log(
      `CSV: ${outputFile}`
    );

    if (metrics.error) {
      console.error(
        metrics.error
      );
    }

    process.exitCode =
      metrics.status === 'PASS'
        ? 0
        : 1;
  } catch (error) {
    const message =
      formatError(error);

    console.error(
      '\nCASE 1 CHILD ERROR\n' +
      message
    );

    if (monitor) {
      monitorResult = monitor.stop();
      monitor = null;
    }

    if (metrics) {
      metrics.status =
        stage === 'AUTHENTICATION'
          ? 'AUTH_ERROR'
          : stage === 'CREDENTIAL_LOOKUP'
            ? 'CREDENTIAL_ERROR'
            : stage === 'SETUP' ||
              stage === 'QUERY_PREPARATION'
              ? 'SETUP_ERROR'
              : 'SELECTION_ERROR';

      metrics.error = message;

      metrics.totalMs =
        round(
          performance.now() -
          totalStart
        );

      metrics.sourceDiscoveryMs =
        round(discoveryMs);

      metrics.authenticationMs =
        round(authenticationMs);

      metrics.queryPreparationMs =
        round(queryPreparationMs);

      metrics.overlayIndexMs =
        round(overlayIndexMs);

      metrics.serverMetaIndexMs =
        round(serverMetaIndexMs);

      metrics.podIndexLookupMs =
        round(podIndexLookupMs);

      if (monitorResult) {
        metrics.cpuUserMs =
          round(
            monitorResult.cpuUserMs
          );

        metrics.cpuSystemMs =
          round(
            monitorResult.cpuSystemMs
          );

        metrics.cpuTotalMs =
          round(
            monitorResult.cpuTotalMs
          );

        metrics.cpuUtilizationPercent =
          round(
            monitorResult.cpuUtilizationPercent
          );

        metrics.peakMemoryMB =
          round(
            monitorResult.peakMemoryMB
          );

        metrics.peakHeapUsedMB =
          round(
            monitorResult.peakHeapUsedMB
          );

        metrics.initialMemoryMB =
          round(
            monitorResult.initialMemoryMB
          );

        metrics.finalMemoryMB =
          round(
            monitorResult.finalMemoryMB
          );
      }

      appendCsv(
        outputFile,
        metrics
      );
    }

    process.exitCode = 1;
  } finally {
    if (monitor) {
      monitor.stop();
    }

    if (session) {
      try {
        await session.logout();
      } catch {
        // Ignore logout errors.
      }
    }
  }
}

/* ============================================================
   SPAWN FRESH NODE PROCESS
   ============================================================ */

async function spawnExecution(
  index,
  repetition,
  scale
) {
  return await new Promise(resolve => {
    let settled = false;

    function finish(code) {
      if (settled) {
        return;
      }

      settled = true;
      resolve(code);
    }

    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MB}`,

        SCRIPT_FILE,

        'case1',

        '--scale',
        String(scale),

        '--child-index',
        String(index),

        '--child-repetition',
        String(repetition),
      ],
      {
        cwd: HERE,
        stdio: 'inherit',

        env: {
          ...process.env,
        },
      }
    );

    child.once('error', error => {
      console.error(
        formatError(error)
      );

      finish(1);
    });

    child.once('exit', code => {
      finish(code ?? 1);
    });
  });
}

/* ============================================================
   LATEST CSV STATUS
   ============================================================ */

function latestExecutionRow(outputFile) {
  if (!fs.existsSync(outputFile)) {
    return null;
  }

  const rows = parseCsv(
    fs.readFileSync(
      outputFile,
      'utf8'
    )
  );

  return rows.at(-1) ?? null;
}

/* ============================================================
   PARENT RUNNER
   ============================================================ */

async function runParent() {
  const approach = (
    process.argv[2] ?? 'case1'
  ).toLowerCase();

  if (approach !== 'case1') {
    fatal(
      'This script implements Case 1 only.'
    );
  }

  const scale = getFederationScale();

  const repetitions =
    getRepetitionCount();

  const singleMode =
    process.argv.includes('--single');

  const planMode =
    process.argv.includes('--plan');

  const outputFile =
    outputFileForScale(scale);

  printStep(
    'ICDE-SYNTHEA — ESPRESSO CASE 1'
  );

  console.log(
    `Project: ${ROOT}`
  );

  console.log(
    `Overlay indexes: ${OVERLAY_INDEX_DIR}`
  );

  console.log(
    `Federation scale: ${scale}`
  );

  console.log(
    `Scales: ${FEDERATION_SCALES.join(' -> ')}`
  );

  console.log(
    `PSO match mode: ${PSO_MATCH_MODE}`
  );

  console.log(
    `Repetitions: ${repetitions}`
  );

  console.log(
    `Output CSV: ${outputFile}`
  );

  console.log(
    'Execution: overlay -> server -> pod PSO -> Comunica'
  );

  console.log(
    'Overlay server identifiers: S1, S2, S3, S4'
  );

  console.log(
    'Comunica sources: selected PSO indexes only'
  );

  const fullSources =
    discoverFederationSources();

  const selections =
    loadFederationSelections(
      fullSources
    );

  const federation =
    selectFederationScale(
      fullSources,
      scale,
      selections
    );

  const configurations =
    buildWorkload(
      fullSources
    );

  console.log(
    `Full federation pods: ${uniquePodCount(fullSources)}`
  );

  console.log(
    `Selected federation pods: ${uniquePodCount(federation.sources)}`
  );

  console.log(
    `Selected federation servers: ${uniqueServerCount(federation.sources)}`
  );

  console.log(
    `Configurations: ${configurations.length}`
  );

  console.log(
    `Planned executions: ${
      singleMode
        ? 1
        : configurations.length * repetitions
    }`
  );

  if (planMode) {
    console.log(
      '\nPLAN ONLY — no queries executed.'
    );

    return;
  }

  ensureOutputSchema(outputFile);

  if (singleMode) {
    const config = configurations[0];

    printStep(
      'SINGLE CASE 1 EXECUTION'
    );

    console.log(
      `${config.role} ${config.queryId} ${config.identity}`
    );

    const exitCode =
      await spawnExecution(
        0,
        1,
        scale
      );

    const row =
      latestExecutionRow(
        outputFile
      );

    console.log(
      `Latest CSV status: ${row?.status ?? 'NO_ROW'}`
    );

    if (
      exitCode !== 0 ||
      row?.status !== 'PASS'
    ) {
      process.exitCode = 1;
    }

    return;
  }

  const completed =
    completedExecutions(
      outputFile
    );

  let failures = 0;
  let successes = 0;
  let skipped = 0;

  for (
    let repetition = 1;
    repetition <= repetitions;
    repetition++
  ) {
    printStep(
      `REPETITION ${repetition}/${repetitions}`
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

      if (completed.has(key)) {
        skipped++;

        console.log(
          `[${index + 1}/172] SKIP PASS ` +
          `${config.role} ${config.queryId} ${config.identity}`
        );

        continue;
      }

      console.log(
        '\n' + '-'.repeat(70)
      );

      console.log(
        `[${index + 1}/172] ` +
        `${config.role} ` +
        `${config.queryId} ` +
        `${config.identity}`
      );

      console.log(
        `Scale=${scale}, repetition=${repetition}`
      );

      const exitCode =
        await spawnExecution(
          index,
          repetition,
          scale
        );

      const row =
        latestExecutionRow(
          outputFile
        );

      console.log(
        `Latest CSV status: ${row?.status ?? 'NO_ROW'}`
      );

      if (
        exitCode === 0 &&
        row?.status === 'PASS' &&
        Number(row.selectedIndexFiles || 0) > 0 &&
        Number(row.comunicaMs || 0) > 0
      ) {
        successes++;
        completed.add(key);
      } else {
        failures++;

        console.error(
          [
            'CASE 1 EXECUTION FAILED',
            `query=${config.queryId}`,
            `identity=${config.identity}`,
            `status=${row?.status ?? 'NO_ROW'}`,
            `exitCode=${exitCode}`,
          ].join(' | ')
        );

        if (
          [
            'AUTH_ERROR',
            'CREDENTIAL_ERROR',
            'AUTH_OR_SETUP_ERROR',
            'SETUP_ERROR',
          ].includes(row?.status)
        ) {
          console.error(
            'Stopping after authentication/setup failure.'
          );

          process.exitCode = 1;
          return;
        }
      }
    }
  }

  printStep(
    `CASE 1 SCALE ${scale} SUMMARY`
  );

  console.log(
    `Scale: ${scale}`
  );

  console.log(
    `Successful new executions: ${successes}`
  );

  console.log(
    `Previously completed: ${skipped}`
  );

  console.log(
    `Failed executions: ${failures}`
  );

  console.log(
    `CSV saved: ${outputFile}`
  );

  if (failures > 0) {
    console.error(
      `Scale ${scale} contains ${failures} failed executions.`
    );

    process.exitCode = 1;
  } else {
    console.log(
      `Scale ${scale} completed without new execution failures.`
    );
  }
}

/* ============================================================
   ENTRY POINT
   ============================================================ */

async function main() {
  if (
    process.argv.includes('--child-index')
  ) {
    await runChild();
  } else {
    await runParent();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    '\nCASE 1 RUNNER FAILED'
  );

  console.error(
    formatError(error)
  );

  process.exitCode = 1;
}