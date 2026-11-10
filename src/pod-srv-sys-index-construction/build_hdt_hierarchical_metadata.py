#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
ICDE-Synthea
Direct HDT-Based Hierarchical Metadata Builder
==============================================

PURPOSE
-------
Build genuine binary Server-Level and Overlay-Level
HDT metadata directly from existing Pod-Level HDT.

NO EXISTING SERVER OR OVERLAY JSON IS READ.

POD-LEVEL INPUT
---------------
Original Pod-Level index filenames:

    espressoindex/
        webid_<sha256>.nq
        public-Location.nq
        ...

Existing genuine Pod-Level HDT:

    espressoindex_hdt/
        webid_<sha256>.hdt
        webid_<sha256>.hdt.acl
        public-Location.hdt
        public-Location.hdt.acl
        ...

Original .nq filenames are used only to identify
expected indexes and check completeness.

Actual predicates are extracted directly from
the genuine Pod-Level HDT contents.

POD-LEVEL HDT REPRESENTATION
----------------------------
Each original N-Quad is encoded as:

    (predicate, espresso:hasStatement, statementURN)
    (statementURN, rdf:subject, subject)
    (statementURN, rdf:predicate, predicate)
    (statementURN, rdf:object, object)
    (statementURN, espresso:source, source)

Original predicates are discovered by searching:

    (?, espresso:hasStatement, ?)

The subject is the original RDF predicate.

SERVER-LEVEL OUTPUT
-------------------
experiments/S1/ESPRESSO-pod/metaindex_hdt/
    webid_<sha256>.hdt
    public.hdt

Same for S2, S3, and S4.

Server representation:

    (predicate, espresso:hdtIndex, podHdtIndexURL)

Only the Pod-Level HDT index URL is stored.

NO separate pod URL.
NO intermediate posting resource.

OVERLAY-LEVEL OUTPUT
--------------------
overlay-query-layer/
    ESPRESSO-overlay-indexes-hdt/
        webid_<sha256>.hdt
        public.hdt

Overlay representation:

    (predicate, espresso:hasServer, serverURL)

PRIVATE/PUBLIC SEPARATION
-------------------------
Private:

    webid_<sha256>.hdt

Contains only metadata from Pod-Level HDT files
with the exact same WebID-specific filename.

Public:

    public.hdt

Contains metadata from public-*.hdt indexes.

Private and public metadata are never mixed.

EMPTY METADATA
--------------
An index with no routing entries contains one
explicit non-routing marker triple.

REPORT
------
overlay-query-layer/
    ESPRESSO-hdt-metadata-build/
        report.json

Records:
    - Pod indexes examined
    - Original predicates discovered
    - Server metadata postings
    - Overlay metadata postings
    - RDF encoding time
    - HDT conversion time
    - HDT validation time
    - Construction time
    - Input and output bytes
    - Compression ratios
    - Total elapsed time
    - Newly created indexes
    - Existing validated indexes

IMPORTANT FIX 1
---------------
Pod-Level HDT files are read in short-lived
subprocesses.

This prevents native HDT resources from
accumulating in the main builder process.

IMPORTANT FIX 2
---------------
This builder supports safe restart.

If an expected Server-Level or Overlay-Level
HDT file already exists:

    1. Open it in an isolated subprocess.
    2. Read its actual RDF triples.
    3. Compare them with the expected triples.
    4. Reuse it only if the contents match.

If the existing file is invalid or incomplete,
the builder stops without modifying it.

Existing valid outputs are never overwritten.

SAFETY
------
- Original RDF resources are not modified.
- Original RDF ACLs are not modified.
- Original PSO indexes are not modified.
- Existing Pod-Level HDT files are not overwritten.
- Existing Pod-Level HDT ACLs are not overwritten.
- Existing Case 1 metadata is not modified.
- Existing dictionary metadata is not modified.
- Existing valid output HDT files are reused.
- Existing invalid output HDT files are not overwritten.
- Temporary RDF files are cleaned.
- No ACLs are generated for local metadata.

The HDT reader may generate auxiliary search
indexes when opening HDT files.

The query runner must use the new server-level
predicate -> hdtIndex URL representation.

REQUIREMENTS
------------
    rdflib
    hdt
    rdf2hdt

RUN
---
cd ~/ICDE-Synthea/overlay-query-layer

source .venv-hdt/bin/activate

ulimit -n 4096

python build_hdt_hierarchical_metadata.py
"""

import csv
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time

from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from rdflib import URIRef


# ============================================================
# CONFIGURATION
# ============================================================

BASE = Path.home() / "ICDE-Synthea"

EXPERIMENTS = BASE / "experiments"

OVERLAY = BASE / "overlay-query-layer"

IDENTITY_CSV = (
    BASE
    / "identity_credentials"
    / "solid_identity_mapping.csv"
)

SERVER_URLS = {
    "S1": "http://localhost:3001/",
    "S2": "http://localhost:3002/",
    "S3": "http://localhost:3003/",
    "S4": "http://localhost:3004/",
}

ORIGINAL_POD_FOLDER = "espressoindex"

POD_HDT_FOLDER = "espressoindex_hdt"

SERVER_OUTPUT_FOLDER = Path(
    "ESPRESSO-pod/metaindex_hdt"
)

OVERLAY_OUTPUT_FOLDER = (
    OVERLAY
    / "ESPRESSO-overlay-indexes-hdt"
)

REPORT_FOLDER = (
    OVERLAY
    / "ESPRESSO-hdt-metadata-build"
)

REPORT_FILE = REPORT_FOLDER / "report.json"

RDF2HDT = (
    BASE
    / "hdt-install"
    / "bin"
    / "rdf2hdt"
)

ESP = "urn:espresso:hdt-index:"

HAS_STATEMENT = ESP + "hasStatement"

HDT_INDEX_RELATION = ESP + "hdtIndex"

HAS_SERVER = ESP + "hasServer"

EMPTY_INDEX_RELATION = ESP + "emptyIndex"

EMPTY_INDEX_VALUE = ESP + "true"

FORMAT_NAME = "ICDE-HDT-HIERARCHICAL-METADATA-3"

WORKER_TIMEOUT_SECONDS = 180


# ============================================================
# LOGGING AND TIMING
# ============================================================

def log(message=""):

    print(
        message,
        flush=True
    )


def elapsed(start):

    return round(
        time.perf_counter() - start,
        6
    )


def utc_now():

    return datetime.now(
        timezone.utc
    ).isoformat()


def compression_ratio(
    original_bytes,
    compressed_bytes
):

    if compressed_bytes == 0:
        return None

    return round(
        original_bytes / compressed_bytes,
        6
    )


# ============================================================
# LOAD WEBIDS
# ============================================================

def load_webids():

    if not IDENTITY_CSV.is_file():

        raise FileNotFoundError(
            IDENTITY_CSV
        )

    with IDENTITY_CSV.open(
        encoding="utf-8-sig",
        newline=""
    ) as handle:

        reader = csv.DictReader(
            handle
        )

        normalized = {
            column.strip()
            .lower()
            .replace("-", "_"): column

            for column in (
                reader.fieldnames or []
            )
        }

        candidates = (
            "webid",
            "web_id",
            "solid_webid",
            "solid_web_id",
            "webid_url",
            "web_id_url",
        )

        webid_column = next(
            (
                normalized[name]
                for name in candidates
                if name in normalized
            ),
            None
        )

        if webid_column is None:

            raise ValueError(
                "WebID column not found "
                "in identity CSV."
            )

        webids = sorted(
            {
                (
                    row.get(
                        webid_column
                    ) or ""
                ).strip()

                for row in reader
            }
            - {""}
        )

    if not webids:

        raise ValueError(
            "No WebIDs found."
        )

    for webid in webids:

        if not webid.startswith(
            (
                "http://",
                "https://"
            )
        ):

            raise ValueError(
                f"Invalid WebID: {webid}"
            )

    return webids


# ============================================================
# WEBID INDEX NAME
# ============================================================

def index_name(webid):

    digest = hashlib.sha256(
        webid.encode("utf-8")
    ).hexdigest()

    return "webid_" + digest


# ============================================================
# DISCOVER PODS
# ============================================================

def discover_pods(server_root):

    pods = []

    patient_root = (
        server_root
        / "patient_pods"
    )

    if patient_root.is_dir():

        for pod in sorted(
            patient_root.iterdir()
        ):

            if pod.is_dir():

                pods.append(
                    pod
                )

    facility_root = (
        server_root
        / "facility_pods"
    )

    if facility_root.is_dir():

        for category in sorted(
            facility_root.iterdir()
        ):

            if not category.is_dir():
                continue

            for pod in sorted(
                category.iterdir()
            ):

                if pod.is_dir():

                    pods.append(
                        pod
                    )

    return pods


# ============================================================
# RESOURCE URL
# ============================================================

def resource_url(
    server_root,
    server_url,
    path
):

    relative = path.relative_to(
        server_root
    ).as_posix()

    return (
        server_url.rstrip("/")
        + "/"
        + quote(
            relative,
            safe="/._-~"
        )
    )


# ============================================================
# NORMALIZE HDT IRI
# ============================================================

def normalize_iri(value):

    if isinstance(
        value,
        bytes
    ):

        value = value.decode(
            "utf-8"
        )

    value = str(
        value
    )

    if (
        value.startswith("<")
        and value.endswith(">")
    ):

        value = value[1:-1]

    if not value.startswith(
        (
            "http://",
            "https://",
            "urn:"
        )
    ):

        raise ValueError(
            "Unexpected RDF IRI: "
            f"{value}"
        )

    return value


# ============================================================
# ISOLATED HDT WORKER
# ============================================================

HDT_WORKER_CODE = r'''
import json
import sys
from hdt import HDTDocument

mode = sys.argv[1]
hdt_path = sys.argv[2]
output_path = sys.argv[3]

HAS_STATEMENT = "urn:espresso:hdt-index:hasStatement"


def normalize_iri(value):

    if isinstance(value, bytes):
        value = value.decode("utf-8")

    value = str(value)

    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1]

    if not value.startswith(
        ("http://", "https://", "urn:")
    ):
        raise ValueError(
            f"Unexpected RDF IRI: {value}"
        )

    return value


document = HDTDocument(hdt_path)

if mode == "predicates":

    iterator, reported_count = (
        document.search_triples(
            "",
            HAS_STATEMENT,
            ""
        )
    )

    predicates = set()
    actual_count = 0

    for subject, predicate, obj in iterator:

        relation = normalize_iri(predicate)

        if relation != HAS_STATEMENT:
            raise RuntimeError(
                f"Unexpected HDT relation: {relation}"
            )

        predicates.add(
            normalize_iri(subject)
        )

        actual_count += 1

    if actual_count != reported_count:
        raise RuntimeError(
            "HDT routing count mismatch: "
            f"{hdt_path}; "
            f"reported={reported_count}; "
            f"read={actual_count}"
        )

    result = {
        "predicates": sorted(predicates),
        "statementCount": actual_count
    }

elif mode == "triples":

    iterator, reported_count = (
        document.search_triples(
            "",
            "",
            ""
        )
    )

    triples = []
    actual_count = 0

    for subject, predicate, obj in iterator:

        triples.append(
            [
                normalize_iri(subject),
                normalize_iri(predicate),
                normalize_iri(obj)
            ]
        )

        actual_count += 1

    if actual_count != reported_count:
        raise RuntimeError(
            "HDT triple count mismatch: "
            f"{hdt_path}; "
            f"reported={reported_count}; "
            f"read={actual_count}"
        )

    result = {
        "triples": triples,
        "tripleCount": actual_count
    }

else:

    raise ValueError(
        f"Unknown HDT worker mode: {mode}"
    )

with open(
    output_path,
    "w",
    encoding="utf-8"
) as handle:

    json.dump(
        result,
        handle,
        ensure_ascii=False
    )
'''


# ============================================================
# RUN ISOLATED HDT WORKER
# ============================================================

def run_hdt_worker(
    mode,
    hdt_path
):

    """
    Open one HDT in a separate Python process.

    Native HDT resources are released when
    the subprocess exits.

    Worker results are written to a temporary
    JSON file, not stdout.

    This avoids mixing native HDT diagnostic
    messages with the actual results.
    """

    hdt_path = Path(
        hdt_path
    )

    if not hdt_path.is_file():

        raise FileNotFoundError(
            hdt_path
        )

    if hdt_path.stat().st_size == 0:

        raise ValueError(
            "Empty HDT file: "
            f"{hdt_path}"
        )

    with tempfile.TemporaryDirectory(
        prefix="espresso-hdt-reader-"
    ) as temporary_dir:

        result_path = (
            Path(temporary_dir)
            / "result.json"
        )

        command = [
            sys.executable,
            "-c",
            HDT_WORKER_CODE,
            mode,
            str(hdt_path),
            str(result_path)
        ]

        try:

            result = subprocess.run(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=WORKER_TIMEOUT_SECONDS
            )

        except subprocess.TimeoutExpired as exc:

            raise RuntimeError(
                "HDT worker timed out:\n"
                f"{hdt_path}"
            ) from exc

        if result.returncode != 0:

            raise RuntimeError(
                "HDT worker failed:\n"
                f"Mode: {mode}\n"
                f"File: {hdt_path}\n"
                f"Exit code: {result.returncode}\n"
                f"{result.stderr}"
            )

        if not result_path.is_file():

            raise RuntimeError(
                "HDT worker produced no result:\n"
                f"{hdt_path}"
            )

        with result_path.open(
            encoding="utf-8"
        ) as handle:

            return json.load(
                handle
            )


# ============================================================
# READ ORIGINAL PREDICATES FROM POD HDT
# ============================================================

def read_hdt_predicates(hdt_path):

    """
    Read original predicates directly from
    the Pod-Level genuine HDT.

    Match:

        (?predicate, espresso:hasStatement, ?stmt)

    The subject is the original RDF predicate.

    Uses an isolated subprocess to avoid
    native HDT resource accumulation.
    """

    result = run_hdt_worker(
        "predicates",
        hdt_path
    )

    predicates = result.get(
        "predicates"
    )

    if not isinstance(
        predicates,
        list
    ):

        raise RuntimeError(
            "Invalid predicate worker result:\n"
            f"{hdt_path}"
        )

    return {
        normalize_iri(
            predicate
        )
        for predicate in predicates
    }


# ============================================================
# TERM TO N-TRIPLES
# ============================================================

def nt_line(
    subject,
    predicate,
    obj
):

    return (
        subject.n3()
        + " "
        + predicate.n3()
        + " "
        + obj.n3()
        + " .\n"
    )


# ============================================================
# SERVER-LEVEL RDF TRIPLES
# ============================================================

def server_triples(postings):

    """
    Input:

        (predicate, hdtURL)

    Output:

        predicate -> Pod-Level HDT index URL

    Each distinct association becomes
    exactly one RDF triple.

    No pod URL is stored.

    No intermediate posting resource
    is created.
    """

    triples = set()

    for (
        predicate,
        hdt_url
    ) in postings:

        triples.add(
            (
                URIRef(predicate),
                URIRef(
                    HDT_INDEX_RELATION
                ),
                URIRef(hdt_url)
            )
        )

    return triples


# ============================================================
# OVERLAY-LEVEL RDF TRIPLES
# ============================================================

def overlay_triples(
    predicate_servers
):

    """
    Input:

        predicate -> set(serverNames)

    Output:

        predicate -> serverURL
    """

    triples = set()

    for predicate, servers in (
        predicate_servers.items()
    ):

        for server_name in servers:

            triples.add(
                (
                    URIRef(predicate),
                    URIRef(
                        HAS_SERVER
                    ),
                    URIRef(
                        SERVER_URLS[
                            server_name
                        ]
                    )
                )
            )

    return triples


# ============================================================
# EMPTY INDEX MARKER
# ============================================================

def empty_index_triples(
    level,
    server_name,
    index_name_value
):

    """
    Create a genuine RDF triple when
    an index contains no routing entries.

    The marker does not use hdtIndex
    or hasServer, so it cannot be mistaken
    for a source-selection result.
    """

    identifier = "\x00".join(
        [
            level,
            server_name or "",
            index_name_value
        ]
    ).encode(
        "utf-8"
    )

    digest = hashlib.sha256(
        identifier
    ).hexdigest()

    subject = URIRef(
        "urn:espresso:empty-index:"
        + digest
    )

    return {
        (
            subject,
            URIRef(
                EMPTY_INDEX_RELATION
            ),
            URIRef(
                EMPTY_INDEX_VALUE
            )
        )
    }


# ============================================================
# SORT RDF TRIPLES
# ============================================================

def sorted_triples(triples):

    return sorted(
        triples,
        key=lambda triple: (
            str(triple[0]),
            str(triple[1]),
            str(triple[2])
        )
    )


# ============================================================
# WRITE N-TRIPLES
# ============================================================

def write_nt(
    path,
    triples
):

    with path.open(
        "w",
        encoding="utf-8"
    ) as handle:

        for (
            subject,
            predicate,
            obj
        ) in sorted_triples(
            triples
        ):

            handle.write(
                nt_line(
                    subject,
                    predicate,
                    obj
                )
            )


# ============================================================
# GENUINE RDF TO HDT CONVERSION
# ============================================================

def convert_to_hdt(
    nt_path,
    hdt_path
):

    start = time.perf_counter()

    command = [
        str(RDF2HDT),
        "-f",
        "ntriples",
        str(nt_path),
        str(hdt_path)
    ]

    subprocess.run(
        command,
        check=True
    )

    if (
        not hdt_path.is_file()
        or hdt_path.stat().st_size == 0
    ):

        raise RuntimeError(
            "rdf2hdt did not produce "
            "a nonempty HDT output:\n"
            f"{hdt_path}"
        )

    return elapsed(
        start
    )


# ============================================================
# VALIDATE GENUINE HDT
# ============================================================

def validate_hdt(
    hdt_path,
    expected_triples
):

    """
    Compare the exact expected RDF triple
    set with the actual HDT contents.

    Uses a separate subprocess so that
    validation does not accumulate native
    HDT resources in the main process.
    """

    start = time.perf_counter()

    result = run_hdt_worker(
        "triples",
        hdt_path
    )

    actual = {
        (
            URIRef(
                normalize_iri(subject)
            ),
            URIRef(
                normalize_iri(predicate)
            ),
            URIRef(
                normalize_iri(obj)
            )
        )

        for (
            subject,
            predicate,
            obj
        ) in result["triples"]
    }

    expected = set(
        expected_triples
    )

    reported_count = result[
        "tripleCount"
    ]

    if len(actual) != reported_count:

        raise RuntimeError(
            "HDT contains duplicate or "
            "inconsistent triples:\n"
            f"{hdt_path}\n"
            f"Reported: {reported_count}\n"
            f"Unique: {len(actual)}"
        )

    if actual != expected:

        missing = (
            expected - actual
        )

        unexpected = (
            actual - expected
        )

        raise RuntimeError(
            "HDT validation failed:\n"
            f"{hdt_path}\n"
            f"Missing: {len(missing)}\n"
            f"Unexpected: {len(unexpected)}"
        )

    return {
        "validated": True,
        "triples": len(actual),
        "validationSeconds": elapsed(
            start
        )
    }


# ============================================================
# ATOMIC REPORT WRITE
# ============================================================

def save_report(report):

    REPORT_FOLDER.mkdir(
        parents=True,
        exist_ok=True
    )

    if REPORT_FILE.exists():

        raise FileExistsError(
            "Existing metadata report:\n"
            f"{REPORT_FILE}\n"
            "The builder will not overwrite it."
        )

    fd, temporary_name = tempfile.mkstemp(
        prefix=".hdt-report-",
        suffix=".tmp",
        dir=REPORT_FOLDER
    )

    temporary_path = Path(
        temporary_name
    )

    try:

        with os.fdopen(
            fd,
            "w",
            encoding="utf-8"
        ) as handle:

            json.dump(
                report,
                handle,
                indent=2,
                ensure_ascii=False
            )

            handle.write(
                "\n"
            )

        os.link(
            temporary_path,
            REPORT_FILE
        )

    finally:

        temporary_path.unlink(
            missing_ok=True
        )


# ============================================================
# BUILD OR REUSE ONE HDT METADATA FILE
# ============================================================

def build_one_hdt(
    output_path,
    triples
):

    """
    If output does not exist:
        Build genuine HDT.
        Validate exact RDF contents.
        Publish without overwriting.

    If output already exists:
        Validate exact RDF contents.
        Reuse only when valid.

    Existing invalid files are preserved,
    and the builder stops with an error.
    """

    start = time.perf_counter()

    expected_triples = set(
        triples
    )

    # ------------------------------------------------
    # EXISTING OUTPUT: VALIDATE AND REUSE
    # ------------------------------------------------

    if output_path.exists():

        log(
            "    Existing HDT detected."
        )

        log(
            "    Validating before reuse..."
        )

        if not output_path.is_file():

            raise RuntimeError(
                "Existing output is not a file:\n"
                f"{output_path}"
            )

        if output_path.stat().st_size == 0:

            raise RuntimeError(
                "Existing HDT is empty:\n"
                f"{output_path}\n"
                "File preserved. No overwrite."
            )

        try:

            validation = validate_hdt(
                output_path,
                expected_triples
            )

        except Exception as exc:

            raise RuntimeError(
                "Existing HDT cannot be safely "
                "reused:\n"
                f"{output_path}\n"
                "Its contents could not be "
                "verified against the expected "
                "metadata.\n"
                "The file has NOT been changed."
            ) from exc

        log(
            "    Existing HDT validated."
        )

        log(
            "    Reusing existing file."
        )

        return {
            "output": str(output_path),

            "status": "reused",

            "newlyCreated": False,

            "reusedExisting": True,

            "rdfTriples": len(
                expected_triples
            ),

            "hdtTriples": (
                validation["triples"]
            ),

            "intermediateNTBytes": None,

            "hdtBytes": (
                output_path.stat().st_size
            ),

            "encodingSeconds": 0.0,

            "conversionSeconds": 0.0,

            "validationSeconds": (
                validation[
                    "validationSeconds"
                ]
            ),

            "constructionSeconds": elapsed(
                start
            ),

            "ntToHdtCompressionRatio": None,

            "exactContentValidated": True
        }

    # ------------------------------------------------
    # NEW OUTPUT: BUILD AND VALIDATE
    # ------------------------------------------------

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    with tempfile.TemporaryDirectory(
        prefix=".espresso-hdt-meta-",
        dir=output_path.parent
    ) as temporary_dir:

        temporary = Path(
            temporary_dir
        )

        nt_path = (
            temporary
            / "metadata.nt"
        )

        hdt_path = (
            temporary
            / "metadata.hdt"
        )

        # ------------------------------------
        # RDF ENCODING
        # ------------------------------------

        encoding_start = (
            time.perf_counter()
        )

        write_nt(
            nt_path,
            expected_triples
        )

        encoding_seconds = elapsed(
            encoding_start
        )

        nt_bytes = (
            nt_path.stat().st_size
        )

        # ------------------------------------
        # GENUINE HDT CONVERSION
        # ------------------------------------

        conversion_seconds = (
            convert_to_hdt(
                nt_path,
                hdt_path
            )
        )

        # ------------------------------------
        # EXACT HDT VALIDATION
        # ------------------------------------

        validation = validate_hdt(
            hdt_path,
            expected_triples
        )

        hdt_bytes = (
            hdt_path.stat().st_size
        )

        # ------------------------------------
        # SAFE PUBLICATION
        # ------------------------------------

        os.link(
            hdt_path,
            output_path
        )

        # ------------------------------------
        # METRICS
        # ------------------------------------

        return {
            "output": str(output_path),

            "status": "created",

            "newlyCreated": True,

            "reusedExisting": False,

            "rdfTriples": len(
                expected_triples
            ),

            "hdtTriples": (
                validation["triples"]
            ),

            "intermediateNTBytes": (
                nt_bytes
            ),

            "hdtBytes": (
                hdt_bytes
            ),

            "encodingSeconds": (
                encoding_seconds
            ),

            "conversionSeconds": (
                conversion_seconds
            ),

            "validationSeconds": (
                validation[
                    "validationSeconds"
                ]
            ),

            "constructionSeconds": elapsed(
                start
            ),

            "ntToHdtCompressionRatio": (
                compression_ratio(
                    nt_bytes,
                    hdt_bytes
                )
            ),

            "exactContentValidated": True
        }


# ============================================================
# DISCOVER POD HDT AND EXTRACT POSTINGS
# ============================================================

def collect_pod_postings(
    valid_private_names
):

    """
    Read actual Pod-Level HDT contents.

    Returns:

        server_name -> index_name -> set(
            predicate,
            hdtURL
        )

    Public indexes are aggregated under
    the metadata name "public".

    Private indexes are grouped by their
    exact webid_<sha256> filename.

    No separate pod URL is collected.
    """

    all_postings = defaultdict(
        lambda: defaultdict(set)
    )

    stats = {
        "podsChecked": 0,
        "podIndexesRead": 0,
        "podHdtBytesRead": 0,
        "predicateOccurrences": 0,
        "distinctPredicates": 0,
        "podReadingSeconds": 0
    }

    all_predicates = set()

    start = time.perf_counter()

    for (
        server_name,
        server_url
    ) in SERVER_URLS.items():

        server_root = (
            EXPERIMENTS
            / server_name
        )

        if not server_root.is_dir():

            raise FileNotFoundError(
                f"Missing server: {server_root}"
            )

        server_index_count = 0

        log()

        log(
            f"Scanning Pod-Level HDT "
            f"on {server_name}..."
        )

        for pod in discover_pods(
            server_root
        ):

            original_dir = (
                pod
                / ORIGINAL_POD_FOLDER
            )

            if not original_dir.is_dir():
                continue

            stats[
                "podsChecked"
            ] += 1

            hdt_dir = (
                pod
                / POD_HDT_FOLDER
            )

            for original_index in sorted(
                original_dir.glob(
                    "*.nq"
                )
            ):

                original_name = (
                    original_index.stem
                )

                # ----------------------------
                # PRIVATE/PUBLIC CLASSIFICATION
                # ----------------------------

                if original_name.startswith(
                    "public-"
                ):

                    metadata_name = "public"

                elif original_name in (
                    valid_private_names
                ):

                    metadata_name = (
                        original_name
                    )

                elif original_name.startswith(
                    "webid_"
                ):

                    raise ValueError(
                        "Pod contains WebID index "
                        "not represented in the "
                        "identity mapping:\n"
                        f"{original_index}"
                    )

                else:

                    continue

                # ----------------------------
                # EXPECTED HDT AND ACL
                # ----------------------------

                hdt_path = (
                    hdt_dir
                    / (
                        original_name
                        + ".hdt"
                    )
                )

                acl_path = Path(
                    str(hdt_path) + ".acl"
                )

                if (
                    not hdt_path.is_file()
                    or hdt_path.stat().st_size == 0
                ):

                    raise FileNotFoundError(
                        "Missing or empty Pod-Level "
                        "HDT index:\n"
                        f"{hdt_path}"
                    )

                if (
                    not acl_path.is_file()
                    or acl_path.stat().st_size == 0
                ):

                    raise FileNotFoundError(
                        "Missing or empty Pod-Level "
                        "HDT ACL:\n"
                        f"{acl_path}"
                    )

                # ----------------------------
                # READ ACTUAL HDT PREDICATES
                # ----------------------------

                predicates = (
                    read_hdt_predicates(
                        hdt_path
                    )
                )

                # ----------------------------
                # BUILD POD-LEVEL HDT INDEX URL
                # ----------------------------

                hdt_url = resource_url(
                    server_root,
                    server_url,
                    hdt_path
                )

                # ----------------------------
                # RECORD SERVER POSTINGS
                # ----------------------------

                for predicate in predicates:

                    all_postings[
                        server_name
                    ][metadata_name].add(
                        (
                            predicate,
                            hdt_url
                        )
                    )

                all_predicates.update(
                    predicates
                )

                stats[
                    "predicateOccurrences"
                ] += len(
                    predicates
                )

                stats[
                    "podIndexesRead"
                ] += 1

                stats[
                    "podHdtBytesRead"
                ] += hdt_path.stat().st_size

                server_index_count += 1

                if (
                    stats["podIndexesRead"] % 100
                    == 0
                ):

                    log(
                        "  Pod HDT indexes read: "
                        f"{stats['podIndexesRead']:,}"
                    )

        log(
            f"  {server_name}: "
            f"{server_index_count:,} "
            "Pod-Level HDT indexes read"
        )

    if stats["podIndexesRead"] == 0:

        raise RuntimeError(
            "No Pod-Level HDT indexes found."
        )

    stats["distinctPredicates"] = (
        len(
            all_predicates
        )
    )

    stats["podReadingSeconds"] = elapsed(
        start
    )

    return (
        all_postings,
        stats
    )


# ============================================================
# PREFLIGHT
# ============================================================

def preflight(
    index_names
):

    if not RDF2HDT.is_file():

        raise FileNotFoundError(
            "Missing genuine rdf2hdt:\n"
            f"{RDF2HDT}"
        )

    if not os.access(
        RDF2HDT,
        os.X_OK
    ):

        raise PermissionError(
            "rdf2hdt is not executable:\n"
            f"{RDF2HDT}"
        )

    for server_name in SERVER_URLS:

        server_root = (
            EXPERIMENTS
            / server_name
        )

        if not server_root.is_dir():

            raise FileNotFoundError(
                f"Missing server directory:\n"
                f"{server_root}"
            )

    # Existing metadata HDT files are allowed.
    #
    # They will be validated before reuse.
    #
    # An existing report is not overwritten.

    if REPORT_FILE.exists():

        raise FileExistsError(
            "Existing metadata report detected:\n"
            f"{REPORT_FILE}\n"
            "This report is preserved.\n"
            "Archive or rename it if you need "
            "a new build report."
        )

    existing_count = 0

    for server_name in SERVER_URLS:

        server_root = (
            EXPERIMENTS
            / server_name
        )

        for name in index_names:

            path = (
                server_root
                / SERVER_OUTPUT_FOLDER
                / f"{name}.hdt"
            )

            if path.exists():

                existing_count += 1

    for name in index_names:

        path = (
            OVERLAY_OUTPUT_FOLDER
            / f"{name}.hdt"
        )

        if path.exists():

            existing_count += 1

    log(
        "Existing metadata HDT files found: "
        f"{existing_count:,}"
    )

    if existing_count:

        log(
            "Existing files will be validated "
            "and reused only if correct."
        )


# ============================================================
# MAIN BUILD
# ============================================================

def build():

    total_start = (
        time.perf_counter()
    )

    webids = load_webids()

    private_names = {
        index_name(
            webid
        )
        for webid in webids
    }

    index_names = [
        "public"
    ] + sorted(
        private_names
    )

    log(
        "=" * 70
    )

    log(
        "ESPRESSO: GENUINE HDT "
        "HIERARCHICAL METADATA BUILDER"
    )

    log(
        "=" * 70
    )

    log(
        "Input: Existing genuine "
        "Pod-Level HDT"
    )

    log(
        "Server output: Predicate -> "
        "Pod-Level HDT index URL"
    )

    log(
        "Overlay output: Predicate -> "
        "Server URL"
    )

    log(
        "Separate pod URL: NOT STORED"
    )

    log(
        "Existing dictionary JSON: NOT USED"
    )

    log(
        "HDT reading: ISOLATED SUBPROCESSES"
    )

    log(
        "Existing HDT outputs: VALIDATE AND REUSE"
    )

    log(
        f"WebIDs loaded: {len(webids)}"
    )

    log(
        "Metadata index names: "
        f"{len(index_names)}"
    )

    # ----------------------------------------
    # SAFETY PREFLIGHT
    # ----------------------------------------

    preflight(
        index_names
    )

    # ----------------------------------------
    # READ POD HDT
    # ----------------------------------------

    (
        all_postings,
        pod_stats
    ) = collect_pod_postings(
        private_names
    )

    report = {
        "format": FORMAT_NAME,

        "startedAtUTC": utc_now(),

        "inputFormat": (
            "Genuine Pod-Level HDT"
        ),

        "outputFormat": (
            "Genuine binary HDT"
        ),

        "serverRoutingSchema": (
            "predicate -> podHdtIndexURL"
        ),

        "overlayRoutingSchema": (
            "predicate -> serverURL"
        ),

        "usesPreviousDictionaryJson": False,

        "podHdtReadingMode": (
            "isolated subprocess"
        ),

        "existingOutputPolicy": (
            "validate and reuse; "
            "never overwrite"
        ),

        "webids": len(
            webids
        ),

        "servers": list(
            SERVER_URLS
        ),

        "podStatistics": (
            pod_stats
        ),

        "serverIndexes": [],

        "overlayIndexes": [],

        "serverIndexesCreated": 0,

        "overlayIndexesCreated": 0,

        "serverIndexesReused": 0,

        "overlayIndexesReused": 0
    }

    # ----------------------------------------
    # SERVER-LEVEL HDT
    # ----------------------------------------

    overlay_routes = defaultdict(
        lambda: defaultdict(set)
    )

    log()

    log(
        "Constructing or reusing Server-Level "
        "genuine HDT metadata..."
    )

    for server_name in SERVER_URLS:

        server_root = (
            EXPERIMENTS
            / server_name
        )

        output_dir = (
            server_root
            / SERVER_OUTPUT_FOLDER
        )

        for name in index_names:

            postings = all_postings[
                server_name
            ].get(
                name,
                set()
            )

            # ----------------------------
            # BUILD RDF TRIPLES
            # ----------------------------

            triples = server_triples(
                postings
            )

            # ----------------------------
            # EMPTY INDEX HANDLING
            # ----------------------------

            if not triples:

                triples = empty_index_triples(
                    "server",
                    server_name,
                    name
                )

            # ----------------------------
            # DERIVE OVERLAY ROUTING
            # ----------------------------

            for (
                predicate,
                hdt_url
            ) in postings:

                overlay_routes[
                    name
                ][predicate].add(
                    server_name
                )

            # ----------------------------
            # BUILD OR REUSE GENUINE HDT
            # ----------------------------

            output_path = (
                output_dir
                / f"{name}.hdt"
            )

            log(
                f"  [SERVER] {server_name} "
                f"{name}.hdt"
            )

            metrics = build_one_hdt(
                output_path,
                triples
            )

            metrics["server"] = (
                server_name
            )

            metrics["name"] = (
                name
            )

            metrics["postings"] = (
                len(
                    postings
                )
            )

            metrics[
                "distinctPredicates"
            ] = len(
                {
                    predicate
                    for predicate, _ in postings
                }
            )

            metrics["emptyIndex"] = (
                len(postings) == 0
            )

            report[
                "serverIndexes"
            ].append(
                metrics
            )

            if metrics["newlyCreated"]:

                report[
                    "serverIndexesCreated"
                ] += 1

            else:

                report[
                    "serverIndexesReused"
                ] += 1

            log(
                "    Status: "
                f"{metrics['status']}"
            )

            log(
                "    Postings: "
                f"{len(postings):,}"
            )

            log(
                "    RDF triples: "
                f"{metrics['rdfTriples']:,}"
            )

            log(
                "    HDT bytes: "
                f"{metrics['hdtBytes']:,}"
            )

            log(
                "    Processing time: "
                f"{metrics['constructionSeconds']} s"
            )

    # ----------------------------------------
    # OVERLAY-LEVEL HDT
    # ----------------------------------------

    log()

    log(
        "Constructing or reusing Overlay-Level "
        "genuine HDT metadata..."
    )

    for name in index_names:

        predicate_servers = (
            overlay_routes[
                name
            ]
        )

        triples = overlay_triples(
            predicate_servers
        )

        if not triples:

            triples = empty_index_triples(
                "overlay",
                None,
                name
            )

        output_path = (
            OVERLAY_OUTPUT_FOLDER
            / f"{name}.hdt"
        )

        log(
            f"  [OVERLAY] {name}.hdt"
        )

        metrics = build_one_hdt(
            output_path,
            triples
        )

        metrics["name"] = (
            name
        )

        metrics[
            "distinctPredicates"
        ] = len(
            predicate_servers
        )

        metrics[
            "serverLinks"
        ] = sum(
            len(servers)
            for servers in (
                predicate_servers.values()
            )
        )

        metrics["emptyIndex"] = (
            len(
                predicate_servers
            ) == 0
        )

        report[
            "overlayIndexes"
        ].append(
            metrics
        )

        if metrics["newlyCreated"]:

            report[
                "overlayIndexesCreated"
            ] += 1

        else:

            report[
                "overlayIndexesReused"
            ] += 1

        log(
            "    Status: "
            f"{metrics['status']}"
        )

        log(
            "    Server links: "
            f"{metrics['serverLinks']:,}"
        )

        log(
            "    RDF triples: "
            f"{metrics['rdfTriples']:,}"
        )

        log(
            "    HDT bytes: "
            f"{metrics['hdtBytes']:,}"
        )

        log(
            "    Processing time: "
            f"{metrics['constructionSeconds']} s"
        )

    # ----------------------------------------
    # FINAL REPORT
    # ----------------------------------------

    all_metrics = (
        report["serverIndexes"]
        + report["overlayIndexes"]
    )

    report["finishedAtUTC"] = (
        utc_now()
    )

    report["totalElapsedSeconds"] = (
        elapsed(
            total_start
        )
    )

    report[
        "totalMetadataHdtBytes"
    ] = sum(
        item["hdtBytes"]
        for item in all_metrics
    )

    # Reused files do not have their original
    # intermediate N-Triples measurements.
    #
    # Therefore the following aggregate only
    # covers newly created metadata indexes.

    new_metrics = [
        item
        for item in all_metrics
        if item["newlyCreated"]
    ]

    report[
        "totalIntermediateNTBytes"
    ] = sum(
        item["intermediateNTBytes"]
        for item in new_metrics
    )

    report[
        "totalNewMetadataHdtBytes"
    ] = sum(
        item["hdtBytes"]
        for item in new_metrics
    )

    report[
        "totalConversionSeconds"
    ] = round(
        sum(
            item["conversionSeconds"]
            for item in all_metrics
        ),
        6
    )

    report[
        "totalEncodingSeconds"
    ] = round(
        sum(
            item["encodingSeconds"]
            for item in all_metrics
        ),
        6
    )

    report[
        "totalValidationSeconds"
    ] = round(
        sum(
            item["validationSeconds"]
            for item in all_metrics
        ),
        6
    )

    report[
        "totalServerPostings"
    ] = sum(
        item["postings"]
        for item in (
            report["serverIndexes"]
        )
    )

    report[
        "totalOverlayServerLinks"
    ] = sum(
        item["serverLinks"]
        for item in (
            report["overlayIndexes"]
        )
    )

    if new_metrics:

        report[
            "newIndexesNTToHdtCompressionRatio"
        ] = compression_ratio(
            report["totalIntermediateNTBytes"],
            report["totalNewMetadataHdtBytes"]
        )

    else:

        report[
            "newIndexesNTToHdtCompressionRatio"
        ] = None

    save_report(
        report
    )

    # ----------------------------------------
    # FINAL SUMMARY
    # ----------------------------------------

    log()

    log(
        "=" * 70
    )

    log(
        "GENUINE HDT HIERARCHICAL "
        "METADATA CONSTRUCTION COMPLETE"
    )

    log(
        "=" * 70
    )

    log(
        "Pod-Level HDT indexes read: "
        f"{pod_stats['podIndexesRead']:,}"
    )

    log(
        "Distinct predicates: "
        f"{pod_stats['distinctPredicates']:,}"
    )

    log(
        "Server-Level HDT newly created: "
        f"{report['serverIndexesCreated']:,}"
    )

    log(
        "Server-Level HDT reused: "
        f"{report['serverIndexesReused']:,}"
    )

    log(
        "Overlay-Level HDT newly created: "
        f"{report['overlayIndexesCreated']:,}"
    )

    log(
        "Overlay-Level HDT reused: "
        f"{report['overlayIndexesReused']:,}"
    )

    log(
        "Total server postings: "
        f"{report['totalServerPostings']:,}"
    )

    log(
        "Total overlay server links: "
        f"{report['totalOverlayServerLinks']:,}"
    )

    log(
        "Total HDT metadata bytes: "
        f"{report['totalMetadataHdtBytes']:,}"
    )

    log(
        "Total conversion time this run: "
        f"{report['totalConversionSeconds']} s"
    )

    log(
        "Total validation time this run: "
        f"{report['totalValidationSeconds']} s"
    )

    log(
        "Total elapsed time: "
        f"{report['totalElapsedSeconds']} s"
    )

    log()

    log(
        "Report: "
        f"{REPORT_FILE}"
    )

    log()

    log(
        "Original RDF: UNCHANGED"
    )

    log(
        "Original PSO indexes: UNCHANGED"
    )

    log(
        "Existing dictionary metadata: UNCHANGED"
    )

    log(
        "Pod-Level HDT: PRESERVED"
    )

    log(
        "Existing valid metadata HDT: REUSED"
    )

    log(
        "Missing metadata HDT: CREATED"
    )


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":

    build()