#!/usr/bin/env python3

"""
ICDE-Synthea
WebID-specific pod-level ESPRESSO PSO source-selection indexes.

Creates ONLY:
    *.nq
    *.nq.acl

NO SQLite.

INPUT
-----

~/ICDE-Synthea/experiments/
    S1/
        patient_pods/
            patient_<UUID>/
                *.nq
                *.nq.acl

        facility_pods/
            <category>/
                <facility>/
                    *.nq
                    *.nq.acl
                    patients/
                        ... nested resources ...

    S2/
    S3/
    S4/

Identity mapping:
    ~/ICDE-Synthea/identity_credentials/
        solid_identity_mapping.csv


OUTPUT
------

Within each patient/facility pod:

    espressoindex/
        webid_<sha256>.nq
        webid_<sha256>.nq.acl

        public-Location.nq
        public-Location.nq.acl

        public-Organization.nq
        public-Organization.nq.acl

        ... other public resource indexes ...


INDEX FORMAT
------------

    <subject> <predicate> <object> <source-graph> .

The fourth N-Quads term identifies the original source
resource, including its server and path.

Example:

    <urn:patient:1>
    <urn:predicate:name>
    "Alice"
    <urn:espresso:source:server1/patient_pods/patient_1/Patient.nq> .


ACCESS CONTROL
--------------

Private index:
    acl:agent <ACTUAL_WEBID>
    acl:mode acl:Read

Public index:
    acl:agentClass foaf:Agent
    acl:mode acl:Read

The generator reads explicit acl:accessTo / acl:Read grants
from each original .nq.acl file.

It does not evaluate:
    - inherited ACLs
    - acl:default
    - group membership
    - ACP policies


SAFETY
------

- Never modifies original .nq files.
- Never modifies original .nq.acl files.
- Never modifies identity CSV.
- Never overwrites existing espressoindex directories.
- Validates all original ACLs and RDF before writing.
- Validates generated N-Quads and ACLs.
- Uses temporary staging directories.
- Publishes each completed pod index directory atomically.
- Does not create server-level or overlay-level indexes.


TIMING MEASUREMENTS
-------------------

Records:
    1. Preflight validation time.
    2. PSO construction time for each pod.
    3. Total PSO construction time.
    4. Total end-to-end execution time.

Timing measurements are stored in:
    ~/ICDE-Synthea/pod_pso_build_report.json


INSTALL
-------

python3 -m pip install rdflib


RUN
---

cd ~/ICDE-Synthea/overlay-query-layer
python3 build_pod_pso_indexes.py
"""

import csv
import hashlib
import json
import os
import shutil
import tempfile
import time

from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

from rdflib import Dataset, Graph, Namespace, URIRef
from rdflib.namespace import RDF, FOAF


# ============================================================
# CONFIGURATION
# ============================================================

BASE = Path.home() / "ICDE-Synthea"

EXPERIMENTS = BASE / "experiments"

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

INDEX_FOLDER = "espressoindex"

REPORT_FILE = BASE / "pod_pso_build_report.json"

ACL = Namespace("http://www.w3.org/ns/auth/acl#")

SOURCE_PREFIX = "urn:espresso:source:"

FAIL_ON_PUBLIC_NAME_COLLISION = True


# ============================================================
# IDENTITY MAPPING
# ============================================================

def load_webids():
    """
    Read valid WebIDs from the existing identity CSV.
    """

    if not IDENTITY_CSV.is_file():
        raise FileNotFoundError(
            f"Identity CSV not found: {IDENTITY_CSV}"
        )

    with IDENTITY_CSV.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    ) as handle:

        reader = csv.DictReader(handle)

        if not reader.fieldnames:
            raise RuntimeError(
                "Identity CSV has no header."
            )

        normalized = {
            column.strip().lower().replace("-", "_"): column
            for column in reader.fieldnames
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
            raise RuntimeError(
                "Cannot identify WebID column.\n"
                f"Available columns: {reader.fieldnames}"
            )

        webids = set()

        for row in reader:
            webid = (row.get(webid_column) or "").strip()

            if webid:
                webids.add(webid)

    if not webids:
        raise RuntimeError(
            "Identity CSV contains no WebIDs."
        )

    for webid in webids:
        if not (
            webid.startswith("http://")
            or webid.startswith("https://")
        ):
            raise ValueError(
                f"Invalid WebID URL in CSV: {webid}"
            )

    print(f"Loaded {len(webids)} WebIDs")

    return webids


# ============================================================
# URL HELPERS
# ============================================================

def resource_url(server_root, server_url, path):
    """
    Local path -> CSS HTTP resource URL.
    """

    relative = path.relative_to(server_root).as_posix()

    return (
        server_url.rstrip("/")
        + "/"
        + quote(relative, safe="/._-~")
    )


def source_graph_iri(server_name, server_root, rdf_file):
    """
    Create an ESPRESSO source graph identifier.
    """

    relative = rdf_file.relative_to(server_root).as_posix()

    source_path = (
        f"server{server_name[1:]}/{relative}"
    )

    return URIRef(
        SOURCE_PREFIX
        + quote(source_path, safe="/._-~")
    )


def webid_filename(webid):
    """
    Deterministic private-index filename.
    """

    digest = hashlib.sha256(
        webid.encode("utf-8")
    ).hexdigest()

    return f"webid_{digest}"


# ============================================================
# POD DISCOVERY
# ============================================================

def discover_rdf_files(pod_dir):
    """
    Find original RDF resources recursively.

    Excludes generated espressoindex directories.
    """

    return sorted(
        path
        for path in pod_dir.rglob("*.nq")
        if (
            path.is_file()
            and INDEX_FOLDER not in path.parts
        )
    )


def discover_pods(server_root):
    """
    Discover patient and facility pods.
    """

    pods = []

    patient_root = server_root / "patient_pods"

    if patient_root.is_dir():

        for pod in sorted(patient_root.iterdir()):

            if pod.is_dir() and discover_rdf_files(pod):
                pods.append(pod)

    facility_root = server_root / "facility_pods"

    if facility_root.is_dir():

        for category in sorted(facility_root.iterdir()):

            if not category.is_dir():
                continue

            for pod in sorted(category.iterdir()):

                if pod.is_dir() and discover_rdf_files(pod):
                    pods.append(pod)

    return pods


# ============================================================
# ORIGINAL WEBACL PARSING
# ============================================================

def parse_resource_acl(
    acl_file,
    original_resource_url,
    valid_webids
):
    """
    Read an existing .nq.acl file.

    Return:
        (explicit_authorized_webids, is_public)
    """

    if not acl_file.is_file():
        raise FileNotFoundError(
            f"Missing original ACL: {acl_file}"
        )

    graph = Graph()

    graph.parse(
        acl_file.as_posix(),
        format="turtle",
        publicID=original_resource_url + ".acl"
    )

    resource_iri = URIRef(original_resource_url)

    authorized_webids = set()

    public = False

    unknown_agents = set()

    for authorization in graph.subjects(
        RDF.type,
        ACL.Authorization
    ):

        if (
            ACL.Read
            not in set(graph.objects(authorization, ACL.mode))
        ):
            continue

        if (
            resource_iri
            not in set(
                graph.objects(authorization, ACL.accessTo)
            )
        ):
            continue

        agent_classes = set(
            graph.objects(authorization, ACL.agentClass)
        )

        if FOAF.Agent in agent_classes:
            public = True

        for agent in graph.objects(
            authorization,
            ACL.agent
        ):

            webid = str(agent)

            if webid in valid_webids:
                authorized_webids.add(webid)
            else:
                unknown_agents.add(webid)

    if unknown_agents:
        print(
            f"  WARNING: {acl_file} contains "
            f"{len(unknown_agents)} WebID(s) "
            "not in the identity CSV; "
            "they will not receive private indexes."
        )

    return authorized_webids, public


# ============================================================
# ORIGINAL RDF READING
# ============================================================

def read_rdf_statements(rdf_file):
    """
    Parse an original N-Quads file.

    Yield:
        subject, predicate, object
    """

    dataset = Dataset()

    dataset.parse(
        rdf_file.as_posix(),
        format="nquads"
    )

    for subject, predicate, obj, _graph in dataset.quads(
        (None, None, None, None)
    ):
        yield subject, predicate, obj


def validate_rdf_file(rdf_file):
    """
    Parse the entire source file to catch invalid RDF
    before any indexes are created.
    """

    count = 0

    for _statement in read_rdf_statements(rdf_file):
        count += 1

    return count


# ============================================================
# INDEX ACL GENERATION
# ============================================================

def make_index_acl(index_url, webid=None, public=False):
    """
    Create Turtle WebACL for exactly one index resource.
    """

    if public:
        access_rule = "    acl:agentClass foaf:Agent ;\n"

    else:
        if not webid:
            raise ValueError(
                "Private index requires a WebID."
            )

        access_rule = f"    acl:agent <{webid}> ;\n"

    return (
        "@prefix acl: "
        "<http://www.w3.org/ns/auth/acl#> .\n"
        "@prefix foaf: "
        "<http://xmlns.com/foaf/0.1/> .\n\n"

        "<#authorization>\n"
        "    a acl:Authorization ;\n"
        f"    acl:accessTo <{index_url}> ;\n"
        f"{access_rule}"
        "    acl:mode acl:Read .\n"
    )


def validate_generated_acl(
    acl_text,
    acl_url,
    index_url,
    webid=None,
    public=False
):
    """
    Verify that generated ACL Turtle is parseable and
    contains the intended resource-specific Read grant.
    """

    graph = Graph()

    graph.parse(
        data=acl_text,
        format="turtle",
        publicID=acl_url
    )

    target = URIRef(index_url)

    matching = []

    for authorization in graph.subjects(
        RDF.type,
        ACL.Authorization
    ):

        if (
            target
            not in set(
                graph.objects(authorization, ACL.accessTo)
            )
        ):
            continue

        if (
            ACL.Read
            not in set(
                graph.objects(authorization, ACL.mode)
            )
        ):
            continue

        matching.append(authorization)

    if len(matching) != 1:
        raise RuntimeError(
            f"Generated ACL has no unique Read grant: {acl_url}"
        )

    authorization = matching[0]

    if public:

        if (
            FOAF.Agent
            not in set(
                graph.objects(authorization, ACL.agentClass)
            )
        ):
            raise RuntimeError(
                f"Public ACL lacks foaf:Agent: {acl_url}"
            )

    else:

        if (
            URIRef(webid)
            not in set(
                graph.objects(authorization, ACL.agent)
            )
        ):
            raise RuntimeError(
                f"Private ACL lacks expected WebID: {acl_url}"
            )


# ============================================================
# INDEX CREATION
# ============================================================

def create_pso_index(
    staging_dir,
    final_index_dir,
    basename,
    rdf_resources,
    server_name,
    server_root,
    server_url,
    webid=None,
    public=False
):
    """
    Create one .nq PSO index and its .nq.acl.

    The file is first created in staging_dir, but
    the ACL refers to the FINAL CSS resource URL.
    """

    index_filename = f"{basename}.nq"

    acl_filename = f"{basename}.nq.acl"

    staged_index = staging_dir / index_filename

    staged_acl = staging_dir / acl_filename

    final_index = final_index_dir / index_filename

    index_url = resource_url(
        server_root,
        server_url,
        final_index
    )

    acl_url = index_url + ".acl"

    acl_text = make_index_acl(
        index_url,
        webid=webid,
        public=public
    )

    validate_generated_acl(
        acl_text,
        acl_url,
        index_url,
        webid=webid,
        public=public
    )

    statement_count = 0

    with staged_acl.open(
        "x",
        encoding="utf-8"
    ) as handle:
        handle.write(acl_text)

    with staged_index.open(
        "x",
        encoding="utf-8"
    ) as handle:

        for rdf_file in rdf_resources:

            source_iri = source_graph_iri(
                server_name,
                server_root,
                rdf_file
            )

            for subject, predicate, obj in read_rdf_statements(
                rdf_file
            ):

                handle.write(
                    f"{subject.n3()} "
                    f"{predicate.n3()} "
                    f"{obj.n3()} "
                    f"{source_iri.n3()} .\n"
                )

                statement_count += 1

    validate_rdf_file(staged_index)

    return {
        "indexFile": index_filename,
        "aclFile": acl_filename,
        "statementCount": statement_count,
        "resourceCount": len(rdf_resources)
    }


# ============================================================
# PLAN ONE POD
# ============================================================

def plan_pod(
    pod_dir,
    server_name,
    server_root,
    server_url,
    valid_webids
):
    """
    Determine exactly which indexes will be created.

    Also validate all original RDF and ACL files.

    Returns a complete plan without writing files.
    """

    rdf_files = discover_rdf_files(pod_dir)

    assignments = defaultdict(list)

    public_resources = []

    for rdf_file in rdf_files:

        original_url = resource_url(
            server_root,
            server_url,
            rdf_file
        )

        acl_file = Path(str(rdf_file) + ".acl")

        authorized_webids, is_public = parse_resource_acl(
            acl_file,
            original_url,
            valid_webids
        )

        validate_rdf_file(rdf_file)

        for webid in authorized_webids:
            assignments[webid].append(rdf_file)

        if is_public:
            public_resources.append(rdf_file)

    # --------------------------------------------------------
    # CHECK PUBLIC INDEX NAME COLLISIONS
    # --------------------------------------------------------

    public_names = {}

    for rdf_file in public_resources:

        basename = f"public-{rdf_file.stem}"

        if basename in public_names:

            raise RuntimeError(
                "Duplicate public index filename detected.\n"
                f"Pod: {pod_dir}\n"
                f"First resource: {public_names[basename]}\n"
                f"Second resource: {rdf_file}\n"
                f"Both would generate: {basename}.nq"
            )

        public_names[basename] = rdf_file

    # --------------------------------------------------------
    # CHECK ALL GENERATED FILENAMES
    # --------------------------------------------------------

    filenames = set()

    for webid in assignments:

        name = webid_filename(webid) + ".nq"

        if name in filenames:
            raise RuntimeError(
                f"Private index name collision: {name}"
            )

        filenames.add(name)

    for basename in public_names:

        name = basename + ".nq"

        if name in filenames:
            raise RuntimeError(
                f"Generated index name collision: {name}"
            )

        filenames.add(name)

    return {
        "pod_dir": pod_dir,
        "server_name": server_name,
        "server_root": server_root,
        "server_url": server_url,
        "assignments": assignments,
        "public_resources": public_resources,
        "rdf_resource_count": len(rdf_files)
    }


# ============================================================
# BUILD ONE POD
# ============================================================

def build_pod(plan):
    """
    Build a pod's indexes in a temporary directory.

    Only after every index and ACL is successfully
    generated is the directory renamed to espressoindex.
    """

    pod_dir = plan["pod_dir"]

    server_name = plan["server_name"]

    server_root = plan["server_root"]

    server_url = plan["server_url"]

    assignments = plan["assignments"]

    public_resources = plan["public_resources"]

    final_index_dir = pod_dir / INDEX_FOLDER

    if final_index_dir.exists():
        raise FileExistsError(
            f"Index directory already exists: {final_index_dir}"
        )

    print(f"\nPOD: {pod_dir}")

    print(
        f"  Original RDF resources: "
        f"{plan['rdf_resource_count']}"
    )

    print(
        f"  WebID indexes: {len(assignments)}"
    )

    print(
        f"  Public indexes: {len(public_resources)}"
    )

    result = {
        "pod": str(pod_dir),
        "server": server_name,
        "rdfResources": plan["rdf_resource_count"],
        "webidIndexes": [],
        "publicIndexes": []
    }

    staging_dir = Path(
        tempfile.mkdtemp(
            prefix=".espressoindex-staging-",
            dir=pod_dir
        )
    )

    try:

        # ----------------------------------------------------
        # WEBID-SPECIFIC INDEXES
        # ----------------------------------------------------

        for webid, resources in sorted(
            assignments.items()
        ):

            basename = webid_filename(webid)

            print(
                f"  Creating private PSO: {basename}.nq"
            )

            index_result = create_pso_index(
                staging_dir=staging_dir,
                final_index_dir=final_index_dir,
                basename=basename,
                rdf_resources=resources,
                server_name=server_name,
                server_root=server_root,
                server_url=server_url,
                webid=webid,
                public=False
            )

            index_result["webid"] = webid

            result["webidIndexes"].append(index_result)

        # ----------------------------------------------------
        # PUBLIC INDEXES
        # ----------------------------------------------------

        for rdf_file in public_resources:

            basename = f"public-{rdf_file.stem}"

            print(
                f"  Creating public PSO: {basename}.nq"
            )

            index_result = create_pso_index(
                staging_dir=staging_dir,
                final_index_dir=final_index_dir,
                basename=basename,
                rdf_resources=[rdf_file],
                server_name=server_name,
                server_root=server_root,
                server_url=server_url,
                public=True
            )

            index_result["originalResource"] = str(
                rdf_file
            )

            result["publicIndexes"].append(index_result)

        # ----------------------------------------------------
        # ATOMIC PUBLICATION
        # ----------------------------------------------------

        if final_index_dir.exists():
            raise FileExistsError(
                f"Index directory appeared during build: "
                f"{final_index_dir}"
            )

        os.rename(
            staging_dir,
            final_index_dir
        )

        print("  Pod indexes published successfully.")

        return result

    except Exception:

        if staging_dir.exists():
            shutil.rmtree(staging_dir)

        raise


# ============================================================
# GLOBAL PREFLIGHT
# ============================================================

def preflight(valid_webids):
    """
    Validate ALL source RDF/ACL files and ALL generated
    filename assignments before creating any indexes.

    Refuse to overwrite existing espressoindex dirs.
    """

    plans = []

    for server_name, server_url in SERVER_URLS.items():

        server_root = EXPERIMENTS / server_name

        if not server_root.is_dir():
            raise FileNotFoundError(
                f"Missing server directory: {server_root}"
            )

        pods = discover_pods(server_root)

        print(
            f"{server_name}: {len(pods)} pods discovered"
        )

        for pod_dir in pods:

            final_index_dir = pod_dir / INDEX_FOLDER

            if final_index_dir.exists():
                raise FileExistsError(
                    "Existing index directory found:\n"
                    f"{final_index_dir}\n"
                    "No existing indexes will be overwritten."
                )

            plan = plan_pod(
                pod_dir,
                server_name,
                server_root,
                server_url,
                valid_webids
            )

            plans.append(plan)

    return plans


# ============================================================
# MAIN
# ============================================================

def main():

    # --------------------------------------------------------
    # TIMING: START OF COMPLETE EXECUTION
    # --------------------------------------------------------

    total_start = time.perf_counter()

    print("=" * 70)

    print(
        "ICDE-SYNTHEA: WEBID-SPECIFIC "
        "POD-LEVEL ESPRESSO PSO INDEX GENERATOR"
    )

    print("=" * 70)

    valid_webids = load_webids()

    print("\nValidating all original RDF and ACL files...")

    # --------------------------------------------------------
    # TIMING: PREFLIGHT VALIDATION
    # --------------------------------------------------------

    preflight_start = time.perf_counter()

    plans = preflight(valid_webids)

    preflight_seconds = (
        time.perf_counter() - preflight_start
    )

    print(
        f"\nPreflight validation time: "
        f"{preflight_seconds:.3f} seconds"
    )

    if not plans:
        raise RuntimeError(
            "No patient or facility pods discovered."
        )

    print(
        f"\nPreflight passed for {len(plans)} pods."
    )

    total_private = sum(
        len(plan["assignments"])
        for plan in plans
    )

    total_public = sum(
        len(plan["public_resources"])
        for plan in plans
    )

    print(
        f"Planned WebID-specific indexes: {total_private}"
    )

    print(
        f"Planned public indexes: {total_public}"
    )

    report = {
        "podsProcessed": 0,
        "webidIndexesCreated": 0,
        "publicIndexesCreated": 0,
        "pods": []
    }

    # --------------------------------------------------------
    # TIMING: TOTAL PSO INDEX CONSTRUCTION
    # --------------------------------------------------------

    construction_start = time.perf_counter()

    for plan in plans:

        # ----------------------------------------------------
        # TIMING: ONE POD
        # ----------------------------------------------------

        pod_start = time.perf_counter()

        result = build_pod(plan)

        pod_seconds = (
            time.perf_counter() - pod_start
        )

        result["constructionTimeSeconds"] = round(
            pod_seconds,
            6
        )

        print(
            f"  Pod construction time: "
            f"{pod_seconds:.3f} seconds"
        )

        report["pods"].append(result)

        report["podsProcessed"] += 1

        report["webidIndexesCreated"] += len(
            result["webidIndexes"]
        )

        report["publicIndexesCreated"] += len(
            result["publicIndexes"]
        )

    construction_seconds = (
        time.perf_counter() - construction_start
    )

    # --------------------------------------------------------
    # TIMING: SAVE MEASUREMENTS
    # --------------------------------------------------------

    report["preflightTimeSeconds"] = round(
        preflight_seconds,
        6
    )

    report["totalPSOConstructionTimeSeconds"] = round(
        construction_seconds,
        6
    )

    report["totalExecutionTimeSeconds"] = round(
        time.perf_counter() - total_start,
        6
    )

    REPORT_FILE.write_text(
        json.dumps(report, indent=2),
        encoding="utf-8"
    )

    print("\n" + "=" * 70)

    print(
        "POD-LEVEL ESPRESSO PSO GENERATION COMPLETE"
    )

    print("=" * 70)

    print(
        f"Pods processed: {report['podsProcessed']}"
    )

    print(
        "WebID-specific indexes created: "
        f"{report['webidIndexesCreated']}"
    )

    print(
        "Public indexes created: "
        f"{report['publicIndexesCreated']}"
    )

    # --------------------------------------------------------
    # TIMING: FINAL RESULTS
    # --------------------------------------------------------

    print("\n" + "-" * 70)
    print("INDEX CONSTRUCTION TIMING RESULTS")
    print("-" * 70)

    print(
        f"Preflight validation time: "
        f"{report['preflightTimeSeconds']:.3f} seconds"
    )

    print(
        f"Total PSO construction time: "
        f"{report['totalPSOConstructionTimeSeconds']:.3f} seconds"
    )

    print(
        f"Total execution time: "
        f"{report['totalExecutionTimeSeconds']:.3f} seconds"
    )

    print("-" * 70)

    print(f"\nReport: {REPORT_FILE}")

    print("\nOriginal RDF files: UNCHANGED")
    print("Original RDF ACL files: UNCHANGED")
    print("SQLite files: NONE")
    print("Server-level metadata: NONE")
    print("Overlay-level metadata: NONE")


if __name__ == "__main__":
    main()