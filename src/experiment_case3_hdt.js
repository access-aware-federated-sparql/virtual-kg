#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';

import { Parser as SparqlParser } from 'sparqljs';

import { QueryEngine } from '@comunica/query-sparql-solid';
import { Session } from '@inrupt/solid-client-authn-node';

/* ============================================================
   CASE 3 — ESPRESSO GENUINE HDT HIERARCHICAL SELECTION

   Pipeline:

   Overlay HDT
       predicate -> server URL

   Server HDT
       predicate -> exact pod HDT index URL

   Pod HDT
       predicate -> statement URN
       statement URN -> original RDF triple + provenance

   Provenance
       -> original RDF HTTP URL

   Comunica
       -> original RDF HTTP URLs only

   Existing HDT files are never overwritten.

   Each HDT read uses a fresh Python process to avoid
   native HDT resource accumulation.

   Configuration:
       --scale
       --repetitions
       --config-index
       --start-index
       --single
       --plan
   ============================================================ */

/* ============================================================
   PROJECT PATHS
   ============================================================ */

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT_FILE);

function findProjectRoot(start) {
  let current = start;

  while (true) {
    if (
      fs.existsSync(path.join(current, 'experiments')) &&
      fs.existsSync(
        path.join(current, 'identity_credentials')
      )
    ) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(
        'Cannot locate ICDE-Synthea root.'
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

const OVERLAY_HDT_DIR = path.join(
  ROOT,
  'overlay-query-layer',
  'ESPRESSO-overlay-indexes-hdt'
);

const HDT_READER = path.join(
  HERE,
  'case3_hdt_reader.py'
);

const PYTHON = process.env.CASE3_PYTHON ||
  path.join(
    HERE,
    '.venv-hdt',
    'bin',
    'python'
  );

const CREDENTIAL_FILE = path.join(
  ROOT,
  'identity_credentials',
  'solid_identities.json'
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
  for (const directory of QUERY_DIR_CANDIDATES) {
    if (
      fs.existsSync(
        path.join(
          directory,
          'Q01_patient_active_conditions.rq'
        )
      )
    ) {
      return directory;
    }
  }

  throw new Error(
    'Cannot find query directory.'
  );
}

const QUERY_DIR = findQueryDirectory();

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

function findFederationSelections() {
  for (const file of FEDERATION_SELECTION_CANDIDATES) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  throw new Error(
    'Cannot find federation_scale_selections.json.'
  );
}

const FEDERATION_SELECTION_FILE =
  findFederationSelections();

/* ============================================================
   CONSTANTS
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

const SERVERS = {
  S1: 3001,
  S2: 3002,
  S3: 3003,
  S4: 3004,
};

const DEFAULT_OIDC_ISSUER =
  'http://localhost:3000/';

const CHILD_HEAP_MB = 28672;

const COMUNICA_HTTP_CONCURRENCY = 8;

const SOURCE_GRAPH_PREFIX =
  'urn:espresso:source:';

const PSO_MATCH_MODE =
  process.env.PSO_MATCH_MODE || 'any';

if (!['any', 'all'].includes(PSO_MATCH_MODE)) {
  throw new Error(
    'PSO_MATCH_MODE must be "any" or "all".'
  );
}

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
   CSV SCHEMA
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

function round(value, digits = 3) {
  return Number(value || 0).toFixed(digits);
}

function bytesToMB(bytes) {
  return bytes / (1024 * 1024);
}

function unique(values) {
  return [...new Set(values)];
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

function readJson(file) {
  return JSON.parse(
    fs.readFileSync(file, 'utf8')
  );
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

function serverBaseUrl(server) {
  const port = SERVERS[server];

  if (!port) {
    fatal(`Unknown server: ${server}`);
  }

  return `http://localhost:${port}/`;
}

function hdtFilename(webid) {
  if (webid === 'public') {
    return 'public.hdt';
  }

  return `webid_${sha256(webid)}.hdt`;
}

function outputFileForScale(scale) {
  return path.join(
    HERE,
    `experiment_case3_scale_${scale}.csv`
  );
}

/* ============================================================
   CSV
   ============================================================ */

function csvEscape(value) {
  const text = String(value ?? '');

  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return '"' +
      text.replaceAll('"', '""') +
      '"';
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
    fatal('Malformed CSV.');
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

function ensureOutputSchema(file) {
  const expected = OUTPUT_COLUMNS.join(',');

  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      expected + '\n'
    );

    return;
  }

  const firstLine = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/, 1)[0];

  if (firstLine !== expected) {
    fatal(
      `CSV schema mismatch: ${file}`
    );
  }
}

function appendCsv(file, row) {
  ensureOutputSchema(file);

  fs.appendFileSync(
    file,
    OUTPUT_COLUMNS
      .map(column => csvEscape(row[column]))
      .join(',') + '\n'
  );
}

/* ============================================================
   ARGUMENTS
   ============================================================ */

function argumentValue(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];

  if (!value || value.startsWith('--')) {
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

  if (!Number.isInteger(value) || value < 1) {
    fatal(`Invalid ${name}`);
  }

  return value;
}

function getFederationScale() {
  const scale = Number(
    argumentValue('--scale')
  );

  if (!FEDERATION_SCALES.includes(scale)) {
    fatal(
      `Invalid scale. Allowed: ${FEDERATION_SCALES.join(', ')}`
    );
  }

  return scale;
}

function getRepetitionCount() {
  return positiveIntegerArgument(
    '--repetitions'
  ) ?? 1;
}

function getConfigurationSelection(total) {
  const exact =
    positiveIntegerArgument('--config-index');

  const start =
    positiveIntegerArgument('--start-index');

  if (exact !== null && start !== null) {
    fatal(
      'Use --config-index or --start-index.'
    );
  }

  if (
    (exact !== null && exact > total) ||
    (start !== null && start > total)
  ) {
    fatal(
      `Configuration must be between 1 and ${total}.`
    );
  }

  if (exact !== null) {
    return [exact - 1];
  }

  if (start !== null) {
    return Array.from(
      { length: total - start + 1 },
      (_, i) => start - 1 + i
    );
  }

  if (process.argv.includes('--single')) {
    return [0];
  }

  return Array.from(
    { length: total },
    (_, i) => i
  );
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

  return Object.values(raw).filter(
    value =>
      value &&
      typeof value === 'object'
  );
}

function sourceIdOf(item) {
  return String(
    item.sourceId ??
    item.source_id ??
    item.id ??
    ''
  );
}

function roleOf(item) {
  return String(
    item.role ?? ''
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
      `Credential not found: ${role}/${sourceId}`
    );
  }

  return credential;
}

function credentialWebId(credential) {
  return (
    credential.webId ??
    credential.webid ??
    credential.web_id ??
    credential.solidWebId ??
    credential.solid_webid ??
    null
  );
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
    fatal('Missing Solid client credentials.');
  }

  const url = new URL(issuer);

  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }

  return {
    clientId,
    clientSecret,
    oidcIssuer: url.toString(),
  };
}

/* ============================================================
   FEDERATION SOURCE DISCOVERY
   ============================================================ */

function safeWalk(root, callback) {
  if (!fs.existsSync(root)) {
    return;
  }

  const stack = [root];

  const excluded = new Set([
    '.internal',
    'espressoindex',
    'espressoindex_hdt',
    'ESPRESSO-pod',
  ]);

  while (stack.length) {
    const current = stack.pop();

    for (
      const entry of fs.readdirSync(
        current,
        { withFileTypes: true }
      )
    ) {
      if (
        entry.isDirectory() &&
        excluded.has(entry.name)
      ) {
        continue;
      }

      const full = path.join(
        current,
        entry.name
      );

      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        callback(full);
      }
    }
  }
}

function fileToUrl(server, file) {
  const root = path.join(
    EXPERIMENTS,
    server
  );

  const relative = path
    .relative(root, file)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');

  return serverBaseUrl(server) + relative;
}

function inferPod(server, file) {
  const relative = path.relative(
    path.join(EXPERIMENTS, server),
    file
  );

  const parts = relative.split(path.sep);

  for (let i = 0; i < parts.length; i++) {
    if (
      parts[i] === 'patient_pods' &&
      i + 1 < parts.length
    ) {
      return parts[i + 1];
    }

    if (
      parts[i] === 'facility_pods' &&
      i + 2 < parts.length
    ) {
      return parts[i + 2];
    }
  }

  return '';
}

function podKey(item) {
  return `${item.server}/${item.pod}`;
}

function discoverFederationSources() {
  const sources = [];

  for (const server of Object.keys(SERVERS)) {
    safeWalk(
      path.join(EXPERIMENTS, server),
      file => {
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
      }
    );
  }

  sources.sort(
    (a, b) => a.url.localeCompare(b.url)
  );

  return sources;
}

function uniquePodCount(items) {
  return new Set(
    items.map(podKey)
  ).size;
}

function uniqueServerCount(items) {
  return new Set(
    items.map(item => item.server)
  ).size;
}

function loadFederationSelections(sources) {
  const selections = readJson(
    FEDERATION_SELECTION_FILE
  );

  const actual = new Set(
    sources.map(podKey)
  );

  if (actual.size !== EXPECTED_PODS) {
    fatal(
      `Expected ${EXPECTED_PODS} pods; found ${actual.size}`
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
        `Invalid federation selection: ${scale}`
      );
    }

    for (const key of selected) {
      if (!actual.has(key)) {
        fatal(
          `Unknown selected pod: ${key}`
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
          'Federation selections are not nested.'
        );
      }
    }
  }

  return selections;
}

function selectFederationScale(
  sources,
  scale,
  selections
) {
  const podKeys = new Set(
    selections[String(scale)]
  );

  const selectedSources = sources.filter(
    item => podKeys.has(podKey(item))
  );

  if (
    uniquePodCount(selectedSources) !== scale
  ) {
    fatal('Federation scale selection failed.');
  }

  return {
    sources: selectedSources,
    podKeys,
  };
}

/* ============================================================
   WORKLOAD
   ============================================================ */

function selectedPatients() {
  const patients = new Map();

  for (const row of readCsv(PATIENT_FILE)) {
    const id =
      row.patient_id ??
      row.source_id;

    if (id) {
      patients.set(
        id.toLowerCase(),
        row.distribution_group ??
        row.distributionGroup ??
        ''
      );
    }
  }

  if (patients.size !== 20) {
    fatal('Expected 20 patients.');
  }

  return patients;
}

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
    fatal('Expected 20 practitioners.');
  }

  return map;
}

function loadCohort(name) {
  return new Set(
    readCsv(COHORT_FILES[name])
      .map(row => row.patient_id?.toLowerCase())
      .filter(Boolean)
  );
}

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

function makeConfigurations({
  patients,
  practitioners,
  cohorts,
  wearableSet,
}) {
  const configurations = [];

  for (const [
    patientId,
    distributionGroup,
  ] of patients) {
    for (const queryId of [
      'Q01',
      'Q02',
      'Q03',
      'Q04',
    ]) {
      configurations.push({
        role: 'patient',
        identity: patientId,
        queryId,
        patientIds: [patientId],
        accessGroup: distributionGroup,
      });
    }
  }

  for (const [
    practitionerId,
    patientSet,
  ] of practitioners) {
    const authorised = [
      ...patientSet,
    ].sort();

    if (!authorised.length) {
      fatal(
        `Practitioner has no patients: ${practitionerId}`
      );
    }

    const accessGroup =
      authorised.length === 1
        ? 'LOW'
        : authorised.length <= 3
          ? 'MEDIUM'
          : 'HIGH';

    for (const queryId of [
      'Q05',
      'Q06',
      'Q07',
      'Q08',
    ]) {
      configurations.push({
        role: 'practitioner',
        identity: practitionerId,
        queryId,
        patientIds: [authorised[0]],
        authorisedPatientIds: authorised,
        accessGroup,
      });
    }
  }

  for (const cohortName of [
    'R1',
    'R2',
    'R3',
  ]) {
    const clinical = [
      ...cohorts[cohortName],
    ].sort();

    for (const queryId of [
      'Q09',
      'Q10',
      'Q11',
    ]) {
      configurations.push({
        role: 'researcher',
        identity: cohortName,
        queryId,
        patientIds: clinical,
        accessGroup: cohortName,
      });
    }

    configurations.push({
      role: 'researcher',
      identity: cohortName,
      queryId: 'Q12',
      patientIds: clinical.filter(
        id => wearableSet.has(id)
      ),
      accessGroup: cohortName,
    });
  }

  return configurations;
}

function buildWorkload(sources) {
  const configurations = makeConfigurations({
    patients: selectedPatients(),
    practitioners: practitionerAccess(),

    cohorts: {
      R1: loadCohort('R1'),
      R2: loadCohort('R2'),
      R3: loadCohort('R3'),
    },

    wearableSet: wearablePatients(sources),
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
   SPARQL PATTERNS
   ============================================================ */

function isVariable(term) {
  return (
    term?.termType === 'Variable' ||
    (
      typeof term === 'string' &&
      term.startsWith('?')
    )
  );
}

function isNamedNode(term) {
  return (
    term?.termType === 'NamedNode' ||
    (
      typeof term === 'string' &&
      /^https?:\/\//.test(term)
    )
  );
}

function termValue(term) {
  if (typeof term === 'string') {
    return term.replace(/^<|>$/g, '');
  }

  return term?.value ?? null;
}

function serializeTerm(term) {
  if (!term || isVariable(term)) {
    return null;
  }

  if (typeof term === 'string') {
    if (/^https?:\/\//.test(term)) {
      return {
        termType: 'NamedNode',
        value: termValue(term),
      };
    }

    fatal(
      `Unsupported SPARQL term: ${term}`
    );
  }

  if (term.termType === 'NamedNode') {
    return {
      termType: 'NamedNode',
      value: term.value,
    };
  }

  if (term.termType === 'BlankNode') {
    return {
      termType: 'BlankNode',
      value: term.value,
    };
  }

  if (term.termType === 'Literal') {
    return {
      termType: 'Literal',
      value: term.value,
      language: term.language || '',
      datatype:
        term.datatype?.value ||
        'http://www.w3.org/2001/XMLSchema#string',
    };
  }

  fatal(
    `Unsupported RDF term type: ${term.termType}`
  );
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
      if (!item || typeof item !== 'object') {
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
          !isVariable(pattern.predicate)
      )
      .map(
        pattern => termValue(pattern.predicate)
      )
  );
}

function serializePatterns(patterns) {
  return patterns
    .filter(
      pattern =>
        isNamedNode(pattern.predicate) &&
        !isVariable(pattern.predicate)
    )
    .map(pattern => ({
      subject: serializeTerm(pattern.subject),
      predicate: serializeTerm(pattern.predicate),
      object: serializeTerm(pattern.object),
    }));
}

function queryTemplate(queryId) {
  const file = path.join(
    QUERY_DIR,
    QUERY_FILES[queryId]
  );

  if (!fs.existsSync(file)) {
    fatal(`Missing query: ${file}`);
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

function instantiateQuery(config) {
  const template = queryTemplate(
    config.queryId
  );

  if (config.role === 'researcher') {
    const values = config.patientIds
      .map(patientUri)
      .join('\n    ');

    return template.replaceAll(
      '{{COHORT_PATIENT_URIS}}',
      values
    );
  }

  return template.replaceAll(
    '{{PATIENT_ID}}',
    config.patientIds[0]
  );
}

/* ============================================================
   HDT READER SUBPROCESS

   Fresh Python process per HDT index.

   This avoids accumulating native HDT handles.

   Input/output JSON files are temporary.

   Existing HDT files are read-only at the
   application level.
   ============================================================ */

function readHdt(request) {
  if (!fs.existsSync(PYTHON)) {
    fatal(
      `Python interpreter missing: ${PYTHON}`
    );
  }

  if (!fs.existsSync(HDT_READER)) {
    fatal(
      `HDT reader missing: ${HDT_READER}`
    );
  }

  const temporary = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      'espresso-case3-hdt-'
    )
  );

  const inputFile = path.join(
    temporary,
    'input.json'
  );

  const outputFile = path.join(
    temporary,
    'output.json'
  );

  try {
    fs.writeFileSync(
      inputFile,
      JSON.stringify(request),
      'utf8'
    );

    const result = spawnSync(
      PYTHON,
      [
        HDT_READER,
        '--input',
        inputFile,
        '--output',
        outputFile,
      ],
      {
        cwd: HERE,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      fatal(
        [
          'HDT reader failed.',
          `File: ${request.file}`,
          `Operation: ${request.operation}`,
          result.stderr || '',
        ].join('\n')
      );
    }

    if (!fs.existsSync(outputFile)) {
      fatal(
        `HDT reader produced no output: ${request.file}`
      );
    }

    return readJson(outputFile);
  } finally {
    fs.rmSync(
      temporary,
      {
        recursive: true,
        force: true,
      }
    );
  }
}

/* ============================================================
   METADATA PATHS
   ============================================================ */

function overlayIndexPath(webid) {
  return path.join(
    OVERLAY_HDT_DIR,
    hdtFilename(webid)
  );
}

function serverIndexPath(server, webid) {
  return path.join(
    EXPERIMENTS,
    server,
    'ESPRESSO-pod',
    'metaindex_hdt',
    hdtFilename(webid)
  );
}

/* ============================================================
   URL RESOLUTION
   ============================================================ */

function serverFromUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  for (const [
    server,
    port,
  ] of Object.entries(SERVERS)) {
    if (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(
        url.hostname
      ) &&
      url.port === String(port)
    ) {
      return server;
    }
  }

  return null;
}

function urlToLocalFile(value) {
  const server = serverFromUrl(value);

  if (!server) {
    return null;
  }

  const url = new URL(value);

  if (url.search || url.hash) {
    fatal(
      `Unexpected query or fragment: ${value}`
    );
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => {
      let decoded;

      try {
        decoded = decodeURIComponent(segment);
      } catch {
        fatal(
          `Invalid URL encoding: ${value}`
        );
      }

      if (
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('/') ||
        decoded.includes('\\') ||
        decoded.includes('\0')
      ) {
        fatal(
          `Unsafe URL path: ${value}`
        );
      }

      return decoded;
    });

  const root = path.resolve(
    EXPERIMENTS,
    server
  );

  const file = path.resolve(
    root,
    ...segments
  );

  if (
    file !== root &&
    !file.startsWith(root + path.sep)
  ) {
    fatal(
      `URL escapes server root: ${value}`
    );
  }

  return {
    server,
    file,
  };
}

function podKeyFromUrl(value) {
  const resolved = urlToLocalFile(value);

  if (!resolved) {
    return null;
  }

  const pod = inferPod(
    resolved.server,
    resolved.file
  );

  if (!pod) {
    return null;
  }

  return `${resolved.server}/${pod}`;
}

function categoryFromUrl(value) {
  const resolved = urlToLocalFile(value);

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

  const facilityIndex =
    parts.indexOf('facility_pods');

  if (facilityIndex !== -1) {
    return parts[facilityIndex + 1] || '';
  }

  if (parts.includes('patient_pods')) {
    return 'patient';
  }

  return '';
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

function recordIndexRead(
  file,
  set,
  stats,
  field
) {
  if (!fs.existsSync(file)) {
    fatal(
      `Required HDT index missing: ${file}`
    );
  }

  const stat = fs.statSync(file);

  if (!stat.isFile() || stat.size === 0) {
    fatal(
      `Invalid HDT index: ${file}`
    );
  }

  if (!set.has(file)) {
    set.add(file);
    stats[field] += stat.size;
  }
}

/* ============================================================
   LEVEL 1 — OVERLAY HDT

   Private:
       webid_<sha256>.hdt

   Public:
       public.hdt

   Predicate -> server URL

   Both visibility classes are consulted.
   ============================================================ */

function selectServersFromOverlay({
  webid,
  predicates,
  allowedServers,
  stats,
}) {
  const overlays = [
    {
      file: overlayIndexPath(webid),
      visibility: 'private',
    },

    {
      file: overlayIndexPath('public'),
      visibility: 'public',
    },
  ];

  const selected = new Map();

  for (const overlay of overlays) {
    recordIndexRead(
      overlay.file,
      stats.overlayFiles,
      stats,
      'overlayBytes'
    );

    const result = readHdt({
      operation: 'overlay',
      file: overlay.file,
      predicates,
    });

    for (const serverUrl of result.servers) {
      const server = serverFromUrl(
        serverUrl
      );

      if (!server) {
        fatal(
          `Unknown overlay server URL: ${serverUrl}`
        );
      }

      if (!allowedServers.has(server)) {
        continue;
      }

      const metadataFile = serverIndexPath(
        server,
        overlay.visibility === 'public'
          ? 'public'
          : webid
      );

      const key = [
        server,
        overlay.visibility,
      ].join('|');

      selected.set(key, {
        server,
        serverUrl,
        visibility: overlay.visibility,
        metadataFile,
      });
    }
  }

  return [...selected.values()];
}

/* ============================================================
   LEVEL 2 — SERVER HDT

   Predicate -> exact Pod-Level HDT index URL

   No separate pod URL is expected.
   ============================================================ */

function selectPodIndexesFromServers({
  selectedServerMetadata,
  predicates,
  selectedPodKeys,
  webid,
  stats,
}) {
  const entries = [];
  const seen = new Set();

  const expectedPrivate =
    hdtFilename(webid);

  for (const metadata of selectedServerMetadata) {
    recordIndexRead(
      metadata.metadataFile,
      stats.serverFiles,
      stats,
      'serverBytes'
    );

    const result = readHdt({
      operation: 'server',
      file: metadata.metadataFile,
      predicates,
    });

    for (const entry of result.entries) {
      const hdtUrl = entry.hdtUrl;

      const resolved = urlToLocalFile(
        hdtUrl
      );

      if (
        !resolved ||
        resolved.server !== metadata.server
      ) {
        fatal(
          `Invalid Pod HDT URL: ${hdtUrl}`
        );
      }

      const key = podKeyFromUrl(
        hdtUrl
      );

      if (
        !key ||
        !selectedPodKeys.has(key)
      ) {
        continue;
      }

      const relative = path.relative(
        path.join(
          EXPERIMENTS,
          metadata.server
        ),
        resolved.file
      );

      const parts = relative.split(
        path.sep
      );

      if (
        !parts.includes(
          'espressoindex_hdt'
        )
      ) {
        fatal(
          `Unexpected Pod HDT location: ${hdtUrl}`
        );
      }

      const basename = path.basename(
        resolved.file
      );

      if (
        metadata.visibility === 'private' &&
        basename !== expectedPrivate
      ) {
        fatal(
          `Private HDT visibility mismatch: ${hdtUrl}`
        );
      }

      if (
        metadata.visibility === 'public' &&
        !basename.startsWith('public-')
      ) {
        fatal(
          `Public HDT visibility mismatch: ${hdtUrl}`
        );
      }

      const entryKey = [
        entry.predicate,
        hdtUrl,
      ].join('|');

      if (seen.has(entryKey)) {
        continue;
      }

      seen.add(entryKey);

      entries.push({
        predicate: entry.predicate,
        server: metadata.server,
        podKey: key,
        pod: key.split('/').slice(1).join('/'),
        hdtUrl,
        file: resolved.file,
        category: categoryFromUrl(hdtUrl),
        visibility: metadata.visibility,
      });
    }
  }

  return entries;
}

/* ============================================================
   PROVENANCE -> ORIGINAL RDF

   urn:espresso:source:server1/...
   urn:espresso:source:server2/...
   urn:espresso:source:server3/...
   urn:espresso:source:server4/...
   ============================================================ */

function originalRdfFromGraph(
  graphIri,
  indexEntry,
  selectedPodKeys
) {
  if (
    typeof graphIri !== 'string' ||
    !graphIri.startsWith(
      SOURCE_GRAPH_PREFIX
    )
  ) {
    fatal(
      `Invalid HDT provenance: ${graphIri}`
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
      `Invalid provenance format: ${graphIri}`
    );
  }

  const server = `S${match[1]}`;

  const segments = match[2]
    .split('/')
    .map(segment => {
      let decoded;

      try {
        decoded = decodeURIComponent(segment);
      } catch {
        fatal(
          `Invalid provenance encoding: ${graphIri}`
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
      `Provenance is not an original N-Quads source: ${graphIri}`
    );
  }

  const root = path.resolve(
    EXPERIMENTS,
    server
  );

  const file = path.resolve(
    root,
    ...segments
  );

  if (!file.startsWith(root + path.sep)) {
    fatal(
      `Provenance escapes server root: ${graphIri}`
    );
  }

  const pod = inferPod(
    server,
    file
  );

  if (!pod) {
    fatal(
      `Cannot identify provenance pod: ${graphIri}`
    );
  }

  const key = `${server}/${pod}`;

  if (
    server !== indexEntry.server ||
    key !== indexEntry.podKey
  ) {
    fatal(
      `HDT provenance/index mismatch: ${graphIri}`
    );
  }

  if (!selectedPodKeys.has(key)) {
    fatal(
      `Provenance outside federation scale: ${graphIri}`
    );
  }

  if (
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    fatal(
      `Original RDF missing: ${file}`
    );
  }

  const url = fileToUrl(
    server,
    file
  );

  return {
    server,
    pod,
    podKey: key,
    file,
    url,
    sizeBytes: fs.statSync(file).size,
    category: categoryFromUrl(url),
  };
}

/* ============================================================
   LEVEL 3 — POD HDT MATCHING

   Read genuine binary HDT.

   Reconstruct original triples.

   Match query patterns.

   Extract provenance graphs.

   Resolve original RDF URLs.
   ============================================================ */

function selectMatchingOriginalSources({
  candidateEntries,
  patterns,
  selectedPodKeys,
  stats,
}) {
  const byUrl = new Map();

  for (const entry of candidateEntries) {
    if (!byUrl.has(entry.hdtUrl)) {
      byUrl.set(entry.hdtUrl, entry);
    }
  }

  const selectedIndexes = [];
  const originalsByUrl = new Map();

  const serializedPatterns =
    serializePatterns(patterns);

  let examined = 0;

  for (const entry of byUrl.values()) {
    examined++;

    recordIndexRead(
      entry.file,
      stats.podFiles,
      stats,
      'podBytes'
    );

    console.log(
      [
        `[HDT ${examined}/${byUrl.size}]`,
        path.basename(entry.file),
        `size=${round(
          bytesToMB(
            fs.statSync(entry.file).size
          ),
          2
        )}MB`,
      ].join(' | ')
    );

    const inspection = readHdt({
      operation: 'pod',
      file: entry.file,
      patterns: serializedPatterns,
      matchMode: PSO_MATCH_MODE,
    });

    if (!inspection.matches) {
      console.log(
        `[HDT] NO MATCH → ${entry.hdtUrl}`
      );

      continue;
    }

    selectedIndexes.push({
      ...entry,
      sizeBytes: fs.statSync(
        entry.file
      ).size,
    });

    for (const graph of inspection.graphs) {
      const original = originalRdfFromGraph(
        graph,
        entry,
        selectedPodKeys
      );

      originalsByUrl.set(
        original.url,
        original
      );
    }

    console.log(
      [
        '[HDT] MATCH',
        `statements=${inspection.statementsExamined}`,
        `matchedPatterns=${inspection.matchedPatterns}`,
        `originalRdf=${inspection.graphs.length}`,
        `totalOriginalRdf=${originalsByUrl.size}`,
      ].join(' | ')
    );
  }

  return {
    selectedIndexes,
    selectedOriginalSources: [
      ...originalsByUrl.values(),
    ],
  };
}

/* ============================================================
   HTTP
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

  const fetch = async (...args) => {
    await acquire();

    const first = args[0];

    const url =
      typeof first === 'string'
        ? first
        : first?.url || String(first);

    stats.requests++;
    stats.uniqueUrls.add(url);

    try {
      const response = await baseFetch(...args);

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

  fetch.stats = stats;

  return fetch;
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
  const hash = crypto.createHash('sha256');

  for (const row of [...rows].sort()) {
    hash.update(row);
    hash.update('\n');
  }

  return hash.digest('hex');
}

/* ============================================================
   MEMORY AND CPU
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
   COMUNICA — ORIGINAL RDF ONLY
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

  if (!urls.length) {
    return {
      resultCount: 0,
      resultHash: '',
      runtimeMs: 0,
      http: newHttpStats(),
      status: 'NO_SOURCES_SELECTED',
      error: 'No original RDF sources selected.',
      cpuUserMs: 0,
      cpuSystemMs: 0,
    };
  }

  printStep(
    'COMUNICA — ORIGINAL RDF EXECUTION'
  );

  console.log(
    `Original RDF sources: ${urls.length}`
  );

  console.log(
    'HDT index URLs passed to Comunica: 0'
  );

  const originalFetch =
    session.fetch.bind(session);

  const countingFetch =
    makeBoundedCountingFetch(
      originalFetch,
      COMUNICA_HTTP_CONCURRENCY
    );

  session.fetch = countingFetch;

  const engine = new QueryEngine();

  const start = performance.now();
  const cpuBefore = process.cpuUsage();

  const canonicalRows = [];

  let resultCount = 0;
  let phase = 'initializing';

  const timer = setInterval(() => {
    console.log(
      [
        '[COMUNICA]',
        `phase=${phase}`,
        `results=${resultCount}`,
        `http=${countingFetch.stats.requests}`,
        `errors=${countingFetch.stats.error}`,
        `rss=${round(memoryMB(), 1)}MB`,
      ].join(' | ')
    );
  }, 5000);

  try {
    const stream = await engine.queryBindings(
      queryText,
      {
        sources: urls,

        '@comunica/actor-http-inrupt-solid-client-authn:session':
          session,

        httpRetryCount: 0,

        unionDefaultGraph: true,
      }
    );

    phase = 'reading-bindings';

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
          `[COMUNICA] Results: ${resultCount}`
        );
      }
    }

    phase = 'completed';

    const cpu = cpuDifferenceMs(
      cpuBefore,
      process.cpuUsage()
    );

    return {
      resultCount,
      resultHash:
        resultSetHash(canonicalRows),

      runtimeMs:
        performance.now() - start,

      http: countingFetch.stats,

      status: 'PASS',
      error: '',

      cpuUserMs: cpu.user,
      cpuSystemMs: cpu.system,
    };
  } catch (error) {
    phase = 'error';

    const cpu = cpuDifferenceMs(
      cpuBefore,
      process.cpuUsage()
    );

    return {
      resultCount,
      resultHash: '',

      runtimeMs:
        performance.now() - start,

      http: countingFetch.stats,

      status: 'QUERY_ERROR',
      error: formatError(error),

      cpuUserMs: cpu.user,
      cpuSystemMs: cpu.system,
    };
  } finally {
    clearInterval(timer);

    session.fetch = originalFetch;

    console.log(
      `[COMUNICA] Final phase: ${phase}`
    );
  }
}

/* ============================================================
   EXECUTION RESUME
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

function completedExecutions(file) {
  const completed = new Set();

  if (!fs.existsSync(file)) {
    return completed;
  }

  ensureOutputSchema(file);

  for (const row of parseCsv(
    fs.readFileSync(file, 'utf8')
  )) {
    if (
      row.status !== 'PASS' ||
      Number(row.selectedIndexFiles) <= 0 ||
      Number(row.selectedSources) <= 0 ||
      Number(row.comunicaMs) <= 0
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
   DEFAULT METRICS
   ============================================================ */

function defaultMetrics({
  config,
  repetition,
  scale,
}) {
  const row = {};

  for (const column of OUTPUT_COLUMNS) {
    row[column] = '';
  }

  return {
    ...row,

    timestamp: new Date().toISOString(),

    approach:
      'case3-hdt-original-rdf',

    repetition,
    federationScale: scale,

    role: config.role,
    identity: config.identity,
    accessGroup: config.accessGroup,
    query: config.queryId,

    patientCount:
      config.patientIds.length,

    psoMatchMode: PSO_MATCH_MODE,

    status: 'SETUP_ERROR',
    error: '',
  };
}

/* ============================================================
   CHILD EXECUTION
   ============================================================ */

async function runChild() {
  const scale = getFederationScale();

  const configIndex = Number(
    argumentValue('--child-index')
  );

  const repetition = Number(
    argumentValue('--child-repetition')
  );

  if (
    !Number.isInteger(configIndex) ||
    configIndex < 0 ||
    configIndex >= EXPECTED_CONFIGURATIONS ||
    !Number.isInteger(repetition) ||
    repetition < 1
  ) {
    fatal('Invalid child arguments.');
  }

  const outputFile =
    outputFileForScale(scale);

  const totalStart = performance.now();

  let config = null;
  let metrics = null;
  let session = null;
  let monitor = null;

  let stage = 'SETUP';

  let discoveryMs = 0;
  let preparationMs = 0;
  let authenticationMs = 0;

  let overlayIndexMs = 0;
  let serverMetaIndexMs = 0;
  let podIndexLookupMs = 0;
  let sourceSelectionMs = 0;

  const indexStats = newIndexStats();

  try {
    /* --------------------------------------------------------
       FEDERATION
       -------------------------------------------------------- */

    printStep(
      'CASE 3 — FEDERATION DISCOVERY'
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
      `Configuration: ${configIndex + 1}/172`
    );

    console.log(
      `Scale: ${scale}`
    );

    console.log(
      `Candidate pods: ${metrics.candidatePods}`
    );

    /* --------------------------------------------------------
       QUERY PREPARATION
       -------------------------------------------------------- */

    stage = 'QUERY_PREPARATION';

    const preparationStart =
      performance.now();

    const queryText =
      instantiateQuery(config);

    const patterns =
      extractTriplePatterns(queryText);

    const predicates =
      extractFixedPredicates(patterns);

    preparationMs =
      performance.now() -
      preparationStart;

    metrics.triplePatterns =
      patterns.length;

    metrics.fixedPredicates =
      predicates.length;

    if (!predicates.length) {
      fatal(
        'No fixed predicates for HDT selection.'
      );
    }

    console.log(
      `Query: ${config.queryId}`
    );

    console.log(
      `Fixed predicates: ${predicates.length}`
    );

    /* --------------------------------------------------------
       CREDENTIALS
       -------------------------------------------------------- */

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

    /* --------------------------------------------------------
       AUTHENTICATION
       -------------------------------------------------------- */

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
      fatal('Authenticated WebID unavailable.');
    }

    if (
      expectedWebId &&
      session.info.webId &&
      expectedWebId !== session.info.webId
    ) {
      fatal('Authenticated WebID mismatch.');
    }

    metrics.webId = webid;

    console.log(
      `Authenticated WebID: ${webid}`
    );

    monitor = startResourceMonitor();

    const selectionStart =
      performance.now();

    /* --------------------------------------------------------
       LEVEL 1 — OVERLAY HDT
       -------------------------------------------------------- */

    stage = 'OVERLAY_SELECTION';

    printStep(
      'LEVEL 1 — OVERLAY HDT SELECTION'
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
      `Selected server metadata indexes: ${selectedServerMetadata.length}`
    );

    for (const item of selectedServerMetadata) {
      console.log(
        [
          '[OVERLAY HDT]',
          `server=${item.server}`,
          `visibility=${item.visibility}`,
          `metadata=${item.metadataFile}`,
        ].join(' | ')
      );
    }

    /* --------------------------------------------------------
       LEVEL 2 — SERVER HDT
       -------------------------------------------------------- */

    stage = 'SERVER_SELECTION';

    printStep(
      'LEVEL 2 — SERVER HDT SELECTION'
    );

    const serverStart =
      performance.now();

    const candidateEntries =
      selectPodIndexesFromServers({
        selectedServerMetadata,
        predicates,

        selectedPodKeys:
          federation.podKeys,

        webid,
        stats: indexStats,
      });

    serverMetaIndexMs =
      performance.now() -
      serverStart;

    console.log(
      `Candidate Pod-Level HDT entries: ${candidateEntries.length}`
    );

    /* --------------------------------------------------------
       LEVEL 3 — POD HDT
       -------------------------------------------------------- */

    stage = 'POD_HDT_MATCHING';

    printStep(
      'LEVEL 3 — POD HDT MATCHING + PROVENANCE'
    );

    const podStart =
      performance.now();

    const selection =
      selectMatchingOriginalSources({
        candidateEntries,
        patterns,

        selectedPodKeys:
          federation.podKeys,

        stats: indexStats,
      });

    const selectedIndexes =
      selection.selectedIndexes;

    const selectedOriginalSources =
      selection.selectedOriginalSources;

    podIndexLookupMs =
      performance.now() -
      podStart;

    sourceSelectionMs =
      performance.now() -
      selectionStart;

    /* --------------------------------------------------------
       SOURCE METRICS
       -------------------------------------------------------- */

    const selectedHdtUrls = unique(
      selectedIndexes.map(
        item => item.hdtUrl
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
      selectedHdtUrls.length;

    metrics.selectedIndexFiles =
      selectedHdtUrls.length;

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

    console.log(
      `HDT indexes examined: ${indexStats.podFiles.size}`
    );

    console.log(
      `HDT indexes matched: ${selectedHdtUrls.length}`
    );

    console.log(
      `Original RDF sources: ${selectedOriginalUrls.length}`
    );

    console.log(
      `Total selection: ${round(sourceSelectionMs)} ms`
    );

    /* --------------------------------------------------------
       COMUNICA
       -------------------------------------------------------- */

    stage = 'COMUNICA';

    const comunica = await runComunica({
      queryText,
      selectedOriginalSources,
      session,
    });

    const resources = monitor.stop();
    monitor = null;

    /* --------------------------------------------------------
       FINAL METRICS
       -------------------------------------------------------- */

    metrics.comunicaMs =
      round(comunica.runtimeMs);

    metrics.totalMs =
      round(
        performance.now() -
        totalStart
      );

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
      round(resources.cpuUserMs);

    metrics.cpuSystemMs =
      round(resources.cpuSystemMs);

    metrics.peakMemoryMB =
      round(resources.peakMemoryMB);

    metrics.queryCpuUserMs =
      round(comunica.cpuUserMs);

    metrics.queryCpuSystemMs =
      round(comunica.cpuSystemMs);

    metrics.cpuTotalMs =
      round(resources.cpuTotalMs);

    metrics.cpuUtilizationPercent =
      round(
        resources.cpuUtilizationPercent
      );

    metrics.initialMemoryMB =
      round(resources.initialMemoryMB);

    metrics.finalMemoryMB =
      round(resources.finalMemoryMB);

    metrics.peakHeapUsedMB =
      round(resources.peakHeapUsedMB);

    metrics.authenticationMs =
      round(authenticationMs);

    metrics.queryPreparationMs =
      round(preparationMs);

    appendCsv(
      outputFile,
      metrics
    );

    printStep(
      'CASE 3 EXECUTION SUMMARY'
    );

    console.log(
      `Status: ${metrics.status}`
    );

    console.log(
      `Configuration: ${configIndex + 1}/172`
    );

    console.log(
      `Scale: ${scale}`
    );

    console.log(
      `Query: ${config.queryId}`
    );

    console.log(
      `Selected servers: ${metrics.selectedServers}`
    );

    console.log(
      `Selected pods: ${metrics.selectedPods}`
    );

    console.log(
      `Selected HDT indexes: ${metrics.selectedIndexFiles}`
    );

    console.log(
      `Original RDF sources: ${metrics.selectedSources}`
    );

    console.log(
      `Results: ${metrics.results}`
    );

    console.log(
      `Overlay HDT: ${metrics.overlayIndexMs} ms`
    );

    console.log(
      `Server HDT: ${metrics.serverMetaIndexMs} ms`
    );

    console.log(
      `Pod HDT: ${metrics.podIndexLookupMs} ms`
    );

    console.log(
      `Comunica: ${metrics.comunicaMs} ms`
    );

    console.log(
      `Total: ${metrics.totalMs} ms`
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
      '\nCASE 3 CHILD ERROR\n' +
      message
    );

    let resources = null;

    if (monitor) {
      resources = monitor.stop();
      monitor = null;
    }

    if (metrics) {
      metrics.status =
        stage === 'AUTHENTICATION'
          ? 'AUTH_ERROR'
          : stage === 'CREDENTIAL_LOOKUP'
            ? 'CREDENTIAL_ERROR'
            : stage === 'COMUNICA'
              ? 'QUERY_ERROR'
              : [
                  'SETUP',
                  'QUERY_PREPARATION',
                ].includes(stage)
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

      metrics.queryPreparationMs =
        round(preparationMs);

      metrics.authenticationMs =
        round(authenticationMs);

      metrics.overlayIndexMs =
        round(overlayIndexMs);

      metrics.serverMetaIndexMs =
        round(serverMetaIndexMs);

      metrics.podIndexLookupMs =
        round(podIndexLookupMs);

      if (resources) {
        metrics.cpuUserMs =
          round(resources.cpuUserMs);

        metrics.cpuSystemMs =
          round(resources.cpuSystemMs);

        metrics.cpuTotalMs =
          round(resources.cpuTotalMs);

        metrics.cpuUtilizationPercent =
          round(
            resources.cpuUtilizationPercent
          );

        metrics.peakMemoryMB =
          round(resources.peakMemoryMB);

        metrics.initialMemoryMB =
          round(resources.initialMemoryMB);

        metrics.finalMemoryMB =
          round(resources.finalMemoryMB);

        metrics.peakHeapUsedMB =
          round(resources.peakHeapUsedMB);
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
        // Preserve execution result.
      }
    }
  }
}

/* ============================================================
   FRESH NODE PROCESS
   ============================================================ */

async function spawnExecution(
  index,
  repetition,
  scale
) {
  return await new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MB}`,

        SCRIPT_FILE,

        'case3',

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

    let settled = false;

    function finish(code) {
      if (settled) {
        return;
      }

      settled = true;
      resolve(code);
    }

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
   LATEST CSV ROW
   ============================================================ */

function latestExecutionRow(file) {
  if (!fs.existsSync(file)) {
    return null;
  }

  const rows = parseCsv(
    fs.readFileSync(file, 'utf8')
  );

  return rows.at(-1) ?? null;
}

/* ============================================================
   PARENT RUNNER
   ============================================================ */

async function runParent() {
  const approach = (
    process.argv[2] ?? 'case3'
  ).toLowerCase();

  if (approach !== 'case3') {
    fatal(
      'This runner implements Case 3 only.'
    );
  }

  const scale = getFederationScale();
  const repetitions = getRepetitionCount();

  const planMode =
    process.argv.includes('--plan');

  const outputFile =
    outputFileForScale(scale);

  printStep(
    'ICDE-SYNTHEA — ESPRESSO CASE 3'
  );

  console.log(
    `Project: ${ROOT}`
  );

  console.log(
    `Overlay HDT: ${OVERLAY_HDT_DIR}`
  );

  console.log(
    `Python HDT reader: ${HDT_READER}`
  );

  console.log(
    `Federation scale: ${scale}`
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
    'Pipeline: overlay HDT -> server HDT -> pod HDT -> original RDF -> Comunica'
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
    buildWorkload(fullSources);

  const indices =
    getConfigurationSelection(
      configurations.length
    );

  console.log(
    `Full federation pods: ${uniquePodCount(fullSources)}`
  );

  console.log(
    `Selected federation pods: ${uniquePodCount(federation.sources)}`
  );

  console.log(
    `Configurations: ${configurations.length}`
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
        `[${index + 1}/172] ` +
        `${config.role} ${config.queryId} ${config.identity}`
      );
    }

    return;
  }

  ensureOutputSchema(outputFile);

  const explicitSingle =
    process.argv.includes('--single') ||
    argumentValue('--config-index') !== null;

  const completed =
    completedExecutions(outputFile);

  let successes = 0;
  let failures = 0;
  let skipped = 0;

  for (
    let repetition = 1;
    repetition <= repetitions;
    repetition++
  ) {
    printStep(
      `REPETITION ${repetition}/${repetitions}`
    );

    for (const index of indices) {
      const config = configurations[index];

      const key = executionKey(
        config,
        repetition
      );

      if (
        !explicitSingle &&
        completed.has(key)
      ) {
        skipped++;

        console.log(
          `[${index + 1}/172] SKIP PASS ` +
          `${config.role} ${config.queryId}`
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

      const exitCode =
        await spawnExecution(
          index,
          repetition,
          scale
        );

      const row =
        latestExecutionRow(outputFile);

      const passed =
        exitCode === 0 &&
        row?.status === 'PASS' &&
        Number(row.selectedIndexFiles) > 0 &&
        Number(row.selectedSources) > 0 &&
        Number(row.comunicaMs) > 0;

      if (passed) {
        successes++;
        completed.add(key);
      } else {
        failures++;

        console.error(
          [
            'CASE 3 EXECUTION FAILED',
            `configuration=${index + 1}`,
            `query=${config.queryId}`,
            `status=${row?.status ?? 'NO_ROW'}`,
            `exitCode=${exitCode}`,
          ].join(' | ')
        );

        if (
          [
            'AUTH_ERROR',
            'CREDENTIAL_ERROR',
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
    `CASE 3 SCALE ${scale} SUMMARY`
  );

  console.log(
    `Successful executions: ${successes}`
  );

  console.log(
    `Previously completed: ${skipped}`
  );

  console.log(
    `Failed executions: ${failures}`
  );

  console.log(
    `CSV: ${outputFile}`
  );

  if (failures > 0) {
    process.exitCode = 1;
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
    '\nCASE 3 RUNNER FAILED'
  );

  console.error(
    formatError(error)
  );

  process.exitCode = 1;
}
