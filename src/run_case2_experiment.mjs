#!/usr/bin/env node

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
  path.join(ROOT, 'experiments', 'overlay-query-layer', 'queries'),
  path.join(ROOT, 'overlay-query-layer', 'queries'),
];

function findQueryDirectory() {
  for (const candidate of QUERY_DIR_CANDIDATES) {
    if (
      fs.existsSync(
        path.join(candidate, 'Q01_patient_active_conditions.rq')
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
  path.join(HERE, 'federation_scale_selections.json'),
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
  R1: path.join(ANALYSIS, 'researcher_cohorts', 'R1_LOW.csv'),
  R2: path.join(ANALYSIS, 'researcher_cohorts', 'R2_MEDIUM.csv'),
  R3: path.join(ANALYSIS, 'researcher_cohorts', 'R3_HIGH.csv'),
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
    if (fs.existsSync(path.join(candidate, 'public.json'))) {
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

const SOURCE_GRAPH_PREFIX =
  'urn:espresso:source:';

/* ============================================================
   SERVERS
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
    throw new Error(`Unknown server: ${server}`);
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
   CSV COLUMNS — SAME SCHEMA
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
    `experiment_case2_scale_${scale}.csv`
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
    return '"' + text.replaceAll('"', '""') + '"';
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

function argumentValue(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];

  if (
    value === undefined ||
    value.startsWith('--')
  ) {
    fatal(`Missing value for ${name}`);
  }

  return value;
}

function positiveIntegerArgument(name) {
  const raw = argumentValue(name);

  if (raw === null) {
    return null;
  }

  const value = Number(raw);

  if (
    !Number.isInteger(value) ||
    value < 1
  ) {
    fatal(`${name} must be a positive integer.`);
  }

  return value;
}

function getFederationScale() {
  const raw = argumentValue('--scale');

  if (raw === null) {
    fatal(
      `Missing --scale. Allowed: ${FEDERATION_SCALES.join(', ')}`
    );
  }

  const scale = Number(raw);

  if (!FEDERATION_SCALES.includes(scale)) {
    fatal(`Invalid federation scale: ${scale}`);
  }

  return scale;
}

function getRepetitionCount() {
  return positiveIntegerArgument('--repetitions') ?? 1;
}

function getConfigurationSelection(total) {
  const configIndex =
    positiveIntegerArgument('--config-index');

  const startIndex =
    positiveIntegerArgument('--start-index');

  if (
    configIndex !== null &&
    startIndex !== null
  ) {
    fatal(
      'Use either --config-index or --start-index, not both.'
    );
  }

  if (
    configIndex !== null &&
    configIndex > total
  ) {
    fatal(
      `--config-index must be between 1 and ${total}.`
    );
  }

  if (
    startIndex !== null &&
    startIndex > total
  ) {
    fatal(
      `--start-index must be between 1 and ${total}.`
    );
  }

  if (configIndex !== null) {
    return {
      indices: [configIndex - 1],
      description: `Configuration ${configIndex} only`,
    };
  }

  if (startIndex !== null) {
    return {
      indices: Array.from(
        { length: total - startIndex + 1 },
        (_, i) => startIndex - 1 + i
      ),
      description: `Configurations ${startIndex}–${total}`,
    };
  }

  if (process.argv.includes('--single')) {
    return {
      indices: [0],
      description: 'First configuration only',
    };
  }

  return {
    indices: Array.from(
      { length: total },
      (_, i) => i
    ),
    description: `All ${total} configurations`,
  };
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

  if (
    raw &&
    typeof raw === 'object'
  ) {
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

function credentialFor(
  credentials,
  role,
  sourceId
) {
  const targetRole = role.toLowerCase();
  const targetId = sourceId.toLowerCase();

  const candidates = new Set([
    targetId,
    `${targetRole}_${targetId}`,
  ]);

  const credential = credentials.find(
    item =>
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
      selections[String(FEDERATION_SCALES[i + 1])]
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
      .map(row => row.patient_id?.toLowerCase())
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

    if (!normalized.includes('/wearable_data/')) {
      continue;
    }

    const match = normalized.match(
      /patient_([0-9a-fA-F-]{36})/
    );

    if (match) {
      patients.add(match[1].toLowerCase());
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
    fatal(`Unknown query: ${queryId}`);
  }

  const file = path.join(
    QUERY_DIR,
    filename
  );

  if (!fs.existsSync(file)) {
    fatal(`Missing query file: ${file}`);
  }

  return fs.readFileSync(file, 'utf8');
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

  /*
   * PATIENTS: 20 × 4 = 80
   */
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

  /*
   * PRACTITIONERS: 20 × 4 = 80
   */
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

    const patientId = authorisedPatients[0];

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

  /*
   * RESEARCHERS: 3 × 4 = 12
   */
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

    wearableSet: wearablePatients(fullSources),
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
      .filter(
        pattern =>
          isNamedNode(pattern.predicate) &&
          !pattern.predicateIsVariable
      )
      .map(
        pattern => termValue(pattern.predicate)
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
   METADATA NORMALIZATION
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

    /*
     * A wrapped metadata object may contain only
     * non-predicate informational properties.
     *
     * Keep the original strict validation.
     */
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

  if (
    segments.some(
      segment =>
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        segment.includes('\0')
    )
  ) {
    fatal(
      `Unsafe URL path: ${url}`
    );
  }

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
    path.join(EXPERIMENTS, resolved.server),
    resolved.file
  );

  const parts = relative.split(path.sep);

  const index = parts.indexOf('facility_pods');

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

   UPDATED:

   Accept both:

       "S1"
       "S2"
       "S3"
       "S4"

   and full metadata URLs.

   For S1–S4, construct the correct server metadata URL
   using the visibility of the overlay being read.

   Private overlay:
       webid_<SHA256>.json

   Public overlay:
       public.json

   Old full metadata URLs are preserved.
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

    for (const predicate of predicates) {
      const references =
        predicateMap[predicate] || [];

      for (const reference of references) {
        if (
          typeof reference !== 'string' ||
          !reference.trim()
        ) {
          fatal(
            `Invalid server metadata reference in ${overlay.file}`
          );
        }

        const value = reference.trim();

        let server;
        let metadataUrl;

        /*
         * NEW OVERLAY FORMAT:
         *
         * "S1", "S2", "S3", "S4"
         */
        if (
          Object.prototype.hasOwnProperty.call(
            SERVERS,
            value
          )
        ) {
          server = value;

          /*
           * Build the exact metadata URL for the
           * overlay's public/private visibility.
           */
          const metadataFile = serverIndexPath(
            server,
            overlay.visibility === 'public'
              ? 'public'
              : webid
          );

          metadataUrl = fileToUrl(
            server,
            metadataFile
          );
        } else {
          /*
           * OLD OVERLAY FORMAT:
           *
           * Full HTTP metadata URL.
           *
           * Preserve the supplied URL rather than
           * synthesizing a replacement.
           */
          server = serverFromUrl(value);

          if (!server) {
            fatal(
              [
                'Invalid overlay server reference.',
                `File: ${overlay.file}`,
                `Predicate: ${predicate}`,
                `Reference: ${value}`,
                'Expected S1–S4 or a supported HTTP metadata URL.',
              ].join('\n')
            );
          }

          metadataUrl = value;
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

        const key = podKeyFromUrl(podUrl);

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

        const psoPath =
          new URL(psoUrl).pathname;

        const psoName =
          path.posix.basename(psoPath);

        if (
          !psoName.endsWith('.nq') ||
          !psoPath.includes('/espressoindex/')
        ) {
          continue;
        }

        const expectedPrivateName =
          path.posix.basename(
            new URL(
              metadata.metadataUrl
            ).pathname
          ).replace(
            /\.json$/,
            '.nq'
          );

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
   RDF TERM MATCHING
   ============================================================ */

function rdfTermMatches(actual, expected) {
  if (!expected) {
    return true;
  }

  if (isVariable(expected)) {
    return true;
  }

  if (typeof expected === 'string') {
    return actual.value === termValue(expected);
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
   CASE 2 — PROVENANCE GRAPH -> ORIGINAL RDF

   Supported provenance examples:

   urn:espresso:source:server1/patient_pods/...
   urn:espresso:source:server2/patient_pods/...
   urn:espresso:source:server3/facility_pods/...
   urn:espresso:source:server4/facility_pods/...

   A graph IRI identifies the original source.

   The corresponding HTTP URL is supplied to Comunica.

   Validate:
   - provenance syntax
   - server
   - path encoding
   - path traversal
   - pod membership
   - federation membership
   - original file existence
   ============================================================ */

function originalRdfFromGraph(
  graph,
  indexEntry,
  selectedPodKeys
) {
  if (
    !graph ||
    graph.termType !== 'NamedNode'
  ) {
    fatal(
      `Matching PSO quad has no named provenance graph: ${indexEntry.psoUrl}`
    );
  }

  const graphIri = graph.value;

  if (
    !graphIri.startsWith(
      SOURCE_GRAPH_PREFIX
    )
  ) {
    fatal(
      `Unexpected PSO provenance graph: ${graphIri}`
    );
  }

  const encoded = graphIri.slice(
    SOURCE_GRAPH_PREFIX.length
  );

  const match = encoded.match(
    /^server([1-4])\/(.+)$/
  );

  if (!match) {
    fatal(
      `Invalid PSO provenance format: ${graphIri}`
    );
  }

  const server = `S${match[1]}`;

  /*
   * Decode each path component independently.
   *
   * This rejects encoded path separators and
   * prevents percent-encoded traversal.
   */
  const segments = match[2]
    .split('/')
    .map(segment => {
      let decoded;

      try {
        decoded = decodeURIComponent(segment);
      } catch {
        fatal(
          `Invalid percent encoding in provenance: ${graphIri}`
        );
      }

      if (
        !decoded ||
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('/') ||
        decoded.includes('\\') ||
        decoded.includes('\0')
      ) {
        fatal(
          `Unsafe provenance path: ${graphIri}`
        );
      }

      return decoded;
    });

  if (
    !segments.length ||
    !segments.at(-1).endsWith('.nq')
  ) {
    fatal(
      `Expected original N-Quads source: ${graphIri}`
    );
  }

  const serverRoot = path.resolve(
    EXPERIMENTS,
    server
  );

  const file = path.resolve(
    serverRoot,
    ...segments
  );

  if (
    !file.startsWith(
      serverRoot + path.sep
    )
  ) {
    fatal(
      `Provenance path escapes server root: ${graphIri}`
    );
  }

  const pod = inferPod(server, file);

  if (!pod) {
    fatal(
      `Cannot identify original source pod: ${graphIri}`
    );
  }

  const key = `${server}/${pod}`;

  if (
    server !== indexEntry.server ||
    key !== indexEntry.podKey
  ) {
    fatal(
      [
        'PSO provenance does not match its index.',
        `Index: ${indexEntry.psoUrl}`,
        `Index pod: ${indexEntry.podKey}`,
        `Original: ${graphIri}`,
        `Original pod: ${key}`,
      ].join('\n')
    );
  }

  if (!selectedPodKeys.has(key)) {
    fatal(
      `Provenance source outside federation scale: ${graphIri}`
    );
  }

  if (!fs.existsSync(file)) {
    fatal(
      `Original RDF file does not exist: ${file}`
    );
  }

  const stat = fs.statSync(file);

  if (!stat.isFile()) {
    fatal(
      `Original RDF source is not a file: ${file}`
    );
  }

  const url = fileToUrl(server, file);

  return {
    server,
    pod,
    podKey: key,
    file,
    url,
    sizeBytes: stat.size,
    category: categoryFromUrl(url),
  };
}

/* ============================================================
   CASE 2 — STREAM PSO INDEX AND COLLECT ORIGINAL RDF

   Full PSO scan is necessary to identify all matching
   original RDF source documents.

   any:
     At least one fixed-predicate pattern matches.

   all:
     Every fixed-predicate pattern matches somewhere
     in the candidate PSO index.

   For "all", patterns need not occur in the same
   provenance graph, matching the index-level semantics
   used by Case 1.

   Provenance is extracted from matching quads only.
   ============================================================ */

async function inspectPsoIndex({
  entry,
  patterns,
  selectedPodKeys,
  stats,
}) {
  const resolved = urlToLocalFile(
    entry.psoUrl
  );

  if (
    !resolved ||
    resolved.server !== entry.server
  ) {
    fatal(
      `Cannot resolve PSO index: ${entry.psoUrl}`
    );
  }

  const file = resolved.file;

  if (!fs.existsSync(file)) {
    fatal(
      `PSO index missing: ${file}`
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

  const matched = new Array(
    relevantPatterns.length
  ).fill(false);

  const originalSources = new Map();

  const hasNoFixedPatterns =
    relevantPatterns.length === 0;

  const stream = fs.createReadStream(
    file,
    {
      encoding: 'utf8',
      highWaterMark: 1024 * 1024,
    }
  );

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
        quads = parser.parse(clean + '\n');
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

        let quadMatches =
          hasNoFixedPatterns;

        for (
          let i = 0;
          i < relevantPatterns.length;
          i++
        ) {
          if (
            quadMatchesPattern(
              quad,
              relevantPatterns[i]
            )
          ) {
            matched[i] = true;
            quadMatches = true;
          }
        }

        if (quadMatches) {
          const original = originalRdfFromGraph(
            quad.graph,
            entry,
            selectedPodKeys
          );

          originalSources.set(
            original.url,
            original
          );
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
            `matchedPatterns=${matched.filter(Boolean).length}`,
            `requiredPatterns=${relevantPatterns.length}`,
            `originalRdf=${originalSources.size}`,
            `rss=${memoryMB().toFixed(1)}MB`,
          ].join(' | ')
        );
      }
    }

    const indexMatches =
      hasNoFixedPatterns ||
      (
        PSO_MATCH_MODE === 'all'
          ? matched.every(Boolean)
          : matched.some(Boolean)
      );

    return {
      matches: indexMatches,

      originals: indexMatches
        ? [...originalSources.values()]
        : [],

      file,

      sizeBytes:
        fs.statSync(file).size,

      quadCount,
      lineCount: lineNumber,
    };
  } finally {
    lines.close();
    stream.destroy();
  }
}

/* ============================================================
   LEVEL 3 — SELECT ORIGINAL RDF SOURCES
   ============================================================ */

async function selectMatchingOriginalSources({
  candidateEntries,
  patterns,
  selectedPodKeys,
  stats,
}) {
  const byUrl = new Map();

  for (const entry of candidateEntries) {
    if (!byUrl.has(entry.psoUrl)) {
      byUrl.set(entry.psoUrl, entry);
    }
  }

  const selectedIndexes = [];
  const originalsByUrl = new Map();

  const total = byUrl.size;
  let examined = 0;

  for (const entry of byUrl.values()) {
    examined++;

    const resolved =
      urlToLocalFile(entry.psoUrl);

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

    const inspection =
      await inspectPsoIndex({
        entry,
        patterns,
        selectedPodKeys,
        stats,
      });

    if (inspection.matches) {
      selectedIndexes.push({
        ...entry,
        file,
        sizeBytes,
      });

      for (const original of inspection.originals) {
        originalsByUrl.set(
          original.url,
          original
        );
      }

      console.log(
        [
          '[PSO] MATCH',
          `index=${entry.psoUrl}`,
          `originalRdfInIndex=${inspection.originals.length}`,
          `totalUniqueOriginalRdf=${originalsByUrl.size}`,
        ].join(' | ')
      );
    } else {
      console.log(
        `[PSO] NO MATCH → ${entry.psoUrl}`
      );
    }
  }

  return {
    selectedIndexes,

    selectedOriginalSources: [
      ...originalsByUrl.values(),
    ],
  };
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

      /*
       * Content-Length is an estimate of transfer
       * size, not an independently measured count
       * of bytes consumed from the response body.
       */
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

  for (const [
    variable,
    term,
  ] of binding) {
    entries.push(
      `${variable.value}=${term.termType}:${term.value}`
    );
  }

  entries.sort();

  return entries.join('|');
}

function resultSetHash(rows) {
  const sorted = [...rows].sort();

  const hash =
    crypto.createHash('sha256');

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
   CASE 2 — COMUNICA OVER ORIGINAL RDF URLS
   ============================================================ */

async function runComunica({
  queryText,
  selectedOriginalSources,
  session,
}) {
  const urls = unique(
    selectedOriginalSources.map(
      item => item.url
    )
  );

  const emptyHttp = newHttpStats();

  if (!urls.length) {
    console.error(
      '[COMUNICA] No original RDF sources selected.'
    );

    return {
      resultCount: 0,
      resultHash: '',
      runtimeMs: 0,

      http: emptyHttp,

      status: 'NO_SOURCES_SELECTED',

      error:
        'No original RDF sources selected; Comunica was not executed.',

      cpuUserMs: 0,
      cpuSystemMs: 0,
    };
  }

  printStep(
    'COMUNICA — ORIGINAL RDF EXECUTION'
  );

  console.log(
    `[COMUNICA] Selected original RDF sources: ${urls.length}`
  );

  console.log(
    `[COMUNICA] HTTP concurrency: ${COMUNICA_HTTP_CONCURRENCY}`
  );

  console.log(
    '[COMUNICA] PSO URLs passed to Comunica: 0'
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
          /*
           * CASE 2:
           * ORIGINAL RDF URLS ONLY.
           */
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

    session.fetch = originalSessionFetch;

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
    fs.readFileSync(outputFile, 'utf8')
  );

  for (const row of rows) {
    if (row.status !== 'PASS') {
      continue;
    }

    if (
      Number(row.selectedIndexFiles || 0) === 0 ||
      Number(row.selectedSources || 0) === 0 ||
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

    approach:
      'case2-pso-original-rdf',

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

  const rawIndex =
    argumentValue('--child-index');

  const rawRepetition =
    argumentValue('--child-repetition');

  const configIndex = Number(rawIndex);
  const repetition = Number(rawRepetition);

  if (
    rawIndex === null ||
    rawRepetition === null ||
    !Number.isInteger(configIndex) ||
    configIndex < 0 ||
    configIndex >= EXPECTED_CONFIGURATIONS ||
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
  let selectedOriginalSources = [];
  let candidateEntries = [];

  const indexStats = newIndexStats();

  let monitorResult = null;
  let stage = 'SETUP';

  try {
    /* ========================================================
       FEDERATION DISCOVERY
       ======================================================== */

    printStep(
      'CASE 2 — FEDERATION DISCOVERY'
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
      buildWorkload(fullSources);

    config = configurations[configIndex];

    if (!config) {
      fatal(
        `Invalid configuration index: ${configIndex}`
      );
    }

    discoveryMs =
      performance.now() -
      discoveryStart;

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
      `Configuration: ${configIndex + 1}/${EXPECTED_CONFIGURATIONS}`
    );

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

    printStep('QUERY PREPARATION');

    const preparationStart =
      performance.now();

    const template =
      queryTemplate(config.queryId);

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
      credentialWebId(credential);

    /* ========================================================
       AUTHENTICATION
       ======================================================== */

    stage = 'AUTHENTICATION';

    printStep('AUTHENTICATION');

    session = new Session();

    const authStart =
      performance.now();

    await session.login(
      authFields(credential)
    );

    authenticationMs =
      performance.now() -
      authStart;

    if (!session.info.isLoggedIn) {
      fatal('Authentication failed.');
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
      performance.now() -
      overlayStart;

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
      performance.now() -
      serverStart;

    console.log(
      `Candidate PSO entries: ${candidateEntries.length}`
    );

    console.log(
      `Server metadata lookup: ${round(serverMetaIndexMs)} ms`
    );

    /* ========================================================
       LEVEL 3 — PSO MATCHING + ORIGINAL RDF EXTRACTION
       ======================================================== */

    stage = 'POD_PSO_MATCHING';

    printStep(
      'POD-LEVEL PSO MATCHING + ORIGINAL RDF EXTRACTION'
    );

    const podStart =
      performance.now();

    const selection =
      await selectMatchingOriginalSources({
        candidateEntries,
        patterns,

        selectedPodKeys:
          federation.podKeys,

        stats: indexStats,
      });

    selectedIndexes =
      selection.selectedIndexes;

    selectedOriginalSources =
      selection.selectedOriginalSources;

    podIndexLookupMs =
      performance.now() -
      podStart;

    sourceSelectionMs =
      performance.now() -
      selectionStart;

    console.log(
      `PSO indexes examined: ${indexStats.podFiles.size}`
    );

    console.log(
      `PSO indexes matched: ${selectedIndexes.length}`
    );

    console.log(
      `Original RDF sources selected: ${selectedOriginalSources.length}`
    );

    console.log(
      `Pod lookup + provenance extraction: ${round(podIndexLookupMs)} ms`
    );

    console.log(
      `Total source selection: ${round(sourceSelectionMs)} ms`
    );

    /* ========================================================
       SOURCE COUNTS
       ======================================================== */

    const selectedPsoUrls = unique(
      selectedIndexes.map(
        item => item.psoUrl
      )
    );

    const selectedOriginalUrls = unique(
      selectedOriginalSources.map(
        item => item.url
      )
    );

    const selectedIndexBytes =
      selectedIndexes.reduce(
        (sum, item) =>
          sum + item.sizeBytes,
        0
      );

    const selectedOriginalBytes =
      selectedOriginalSources.reduce(
        (sum, item) =>
          sum + item.sizeBytes,
        0
      );

    metrics.selectedServers =
      new Set(
        selectedOriginalSources.map(
          item => item.server
        )
      ).size;

    metrics.selectedPods =
      new Set(
        selectedOriginalSources.map(
          item => item.podKey
        )
      ).size;

    metrics.selectedSources =
      selectedOriginalUrls.length;

    metrics.selectedSourceBytes =
      selectedOriginalBytes;

    metrics.selectedSourceMB =
      round(
        bytesToMB(selectedOriginalBytes),
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

    metrics.accessCheckMs = '0.000';

    metrics.accessibleOriginalSources = 'NA';
    metrics.deniedOriginalSources = 'NA';

    /* ========================================================
       COMUNICA
       ======================================================== */

    stage = 'COMUNICA';

    const comunica =
      await runComunica({
        queryText,
        selectedOriginalSources,
        session,
      });

    /* ========================================================
       RESOURCE METRICS
       ======================================================== */

    monitorResult = monitor.stop();
    monitor = null;

    const totalMs =
      performance.now() -
      totalStart;

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
      round(monitorResult.cpuUserMs);

    metrics.cpuSystemMs =
      round(monitorResult.cpuSystemMs);

    metrics.peakMemoryMB =
      round(monitorResult.peakMemoryMB);

    metrics.queryCpuUserMs =
      round(comunica.cpuUserMs);

    metrics.queryCpuSystemMs =
      round(comunica.cpuSystemMs);

    metrics.cpuTotalMs =
      round(monitorResult.cpuTotalMs);

    metrics.cpuUtilizationPercent =
      round(
        monitorResult.cpuUtilizationPercent
      );

    metrics.initialMemoryMB =
      round(monitorResult.initialMemoryMB);

    metrics.finalMemoryMB =
      round(monitorResult.finalMemoryMB);

    metrics.peakHeapUsedMB =
      round(monitorResult.peakHeapUsedMB);

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
      'CASE 2 EXECUTION SUMMARY'
    );

    console.log(
      `Status: ${metrics.status}`
    );

    console.log(
      `Configuration: ${configIndex + 1}/${EXPECTED_CONFIGURATIONS}`
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
      `Selected original RDF files: ${metrics.selectedSources}`
    );

    console.log(
      `Selected original RDF MB: ${metrics.selectedSourceMB}`
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
      console.error(metrics.error);
    }

    process.exitCode =
      metrics.status === 'PASS'
        ? 0
        : 1;
  } catch (error) {
    const message = formatError(error);

    console.error(
      '\nCASE 2 CHILD ERROR\n' +
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
              : stage === 'COMUNICA'
                ? 'QUERY_ERROR'
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
          round(monitorResult.cpuUserMs);

        metrics.cpuSystemMs =
          round(monitorResult.cpuSystemMs);

        metrics.cpuTotalMs =
          round(monitorResult.cpuTotalMs);

        metrics.cpuUtilizationPercent =
          round(
            monitorResult.cpuUtilizationPercent
          );

        metrics.peakMemoryMB =
          round(monitorResult.peakMemoryMB);

        metrics.peakHeapUsedMB =
          round(monitorResult.peakHeapUsedMB);

        metrics.initialMemoryMB =
          round(monitorResult.initialMemoryMB);

        metrics.finalMemoryMB =
          round(monitorResult.finalMemoryMB);
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
        // Preserve existing logout behavior.
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

        'case2',

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

    child.once(
      'error',
      error => {
        console.error(
          formatError(error)
        );

        finish(1);
      }
    );

    child.once(
      'exit',
      code => {
        finish(code ?? 1);
      }
    );
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
    process.argv[2] ?? 'case2'
  ).toLowerCase();

  if (approach !== 'case2') {
    fatal(
      'This script implements Case 2 only.'
    );
  }

  const scale = getFederationScale();
  const repetitions = getRepetitionCount();

  const planMode =
    process.argv.includes('--plan');

  const outputFile =
    outputFileForScale(scale);

  printStep(
    'ICDE-SYNTHEA — ESPRESSO CASE 2'
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
    'Execution: overlay -> server -> pod PSO -> original RDF -> Comunica'
  );

  console.log(
    'Comunica sources: selected original RDF files only'
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

  /*
   * NEW:
   *
   * --config-index 162 selects zero-based array index 161.
   *
   * --start-index 162 starts at zero-based array index 161.
   */
  const configurationSelection =
    getConfigurationSelection(
      configurations.length
    );

  const indices =
    configurationSelection.indices;

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
    `Configuration selection: ${configurationSelection.description}`
  );

  console.log(
    `Planned executions: ${indices.length * repetitions}`
  );

  if (planMode) {
    console.log(
      '\nPLAN ONLY — no queries executed.'
    );

    for (const index of indices) {
      const config = configurations[index];

      console.log(
        `[${index + 1}/${configurations.length}] ` +
        `${config.role} ${config.queryId} ${config.identity}`
      );
    }

    return;
  }

  ensureOutputSchema(outputFile);

  /*
   * Preserve the original --single behavior:
   * run one execution even if it already has a PASS row.
   *
   * Also allow --config-index to explicitly rerun one
   * configuration, regardless of existing PASS rows.
   */
  const explicitSingle =
    process.argv.includes('--single') ||
    argumentValue('--config-index') !== null;

  if (explicitSingle) {
    const index = indices[0];
    const config = configurations[index];

    printStep(
      'SINGLE CASE 2 EXECUTION'
    );

    console.log(
      `[${index + 1}/${configurations.length}] ` +
      `${config.role} ${config.queryId} ${config.identity}`
    );

    let failures = 0;

    for (
      let repetition = 1;
      repetition <= repetitions;
      repetition++
    ) {
      console.log(
        `Repetition ${repetition}/${repetitions}`
      );

      const exitCode =
        await spawnExecution(
          index,
          repetition,
          scale
        );

      const row =
        latestExecutionRow(outputFile);

      console.log(
        `Latest CSV status: ${row?.status ?? 'NO_ROW'}`
      );

      if (
        exitCode !== 0 ||
        row?.status !== 'PASS' ||
        Number(row.selectedIndexFiles || 0) <= 0 ||
        Number(row.selectedSources || 0) <= 0 ||
        Number(row.comunicaMs || 0) <= 0
      ) {
        failures++;
      }
    }

    if (failures > 0) {
      process.exitCode = 1;
    }

    return;
  }

  const completed =
    completedExecutions(outputFile);

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

    /*
     * NEW:
     *
     * Iterate over the selected configuration indices
     * rather than always starting at array index zero.
     */
    for (const index of indices) {
      const config = configurations[index];

      const key = executionKey(
        config,
        repetition
      );

      if (completed.has(key)) {
        skipped++;

        console.log(
          `[${index + 1}/${configurations.length}] SKIP PASS ` +
          `${config.role} ${config.queryId} ${config.identity}`
        );

        continue;
      }

      console.log(
        '\n' + '-'.repeat(70)
      );

      console.log(
        `[${index + 1}/${configurations.length}] ` +
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
        Number(row.selectedSources || 0) > 0 &&
        Number(row.comunicaMs || 0) > 0
      ) {
        successes++;
        completed.add(key);
      } else {
        failures++;

        console.error(
          [
            'CASE 2 EXECUTION FAILED',
            `configuration=${index + 1}`,
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
    `CASE 2 SCALE ${scale} SUMMARY`
  );

  console.log(
    `Scale: ${scale}`
  );

  console.log(
    `Configuration selection: ${configurationSelection.description}`
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
    '\nCASE 2 RUNNER FAILED'
  );

  console.error(
    formatError(error)
  );

  process.exitCode = 1;
}