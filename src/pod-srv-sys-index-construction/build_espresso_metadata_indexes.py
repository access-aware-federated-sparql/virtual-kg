#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
ICDE-Synthea: ESPRESSO Hierarchical Metadata Index Builder
==========================================================

Creates:

1. SERVER-LEVEL METADATA

   For each server S1-S4:

   experiments/S1/ESPRESSO-pod/metaindex/
       webid_<sha256>.json
       ...
       public.json

   Private metadata:
       predicate -> [{pod: URL, pso: URL}]

   Public metadata:
       predicate -> [{pod: URL, pso: URL}]

2. OVERLAY-LEVEL METADATA

   overlay-query-layer/ESPRESSO-overlay-indexes/
       webid_<sha256>.json
       ...
       public.json

   UPDATED OVERLAY FORMAT:

       predicate -> ["S1", "S2", "S3", "S4"]

   Only servers containing the relevant predicate
   are included.

   Private overlay:
       Maps predicates to servers containing
       WebID-specific private PSO indexes.

   Public overlay:
       Maps predicates to servers containing
       public PSO indexes.

3. CONSTRUCTION-TIME REPORTS

   overlay-query-layer/ESPRESSO-metadata-build/timings/
       index_construction_times.csv
       pod_pso_parsing_times.csv
       construction_summary.csv
       index_construction_times.json

INPUT
-----

Existing pod-level PSO indexes:

    espressoindex/webid_<sha256>.nq
    espressoindex/public-*.nq

Actual WebIDs:

    ~/ICDE-Synthea/identity_credentials/
        solid_identity_mapping.csv

SERVER URLS
-----------

    S1: http://localhost:3001/
    S2: http://localhost:3002/
    S3: http://localhost:3003/
    S4: http://localhost:3004/

SOURCE SELECTION
----------------

Authenticated user:

    private overlay
        +
    public overlay
        |
        v
    S1 / S2 / S3 / S4
        |
        v
    corresponding private/public server metadata
        |
        v
    relevant private/public pod PSO indexes

The query execution script determines whether
Comunica receives PSO indexes or original RDF files.

SAFETY
------

- Never modifies original RDF resources.
- Never modifies original RDF ACL files.
- Never modifies pod-level PSO indexes.
- Never modifies identity CSV.
- Never overwrites existing metadata JSON files.
- Does not use SQLite.
- Does not create extra data/ directories.
- Reads only existing pod-level PSO indexes.

IMPORTANT
---------

This script creates local JSON metadata files.

It does not create WebACL files for the JSON metadata
or publish the metadata through CSS.

Access control and HTTP publication of the generated
metadata must be configured and tested separately.

RUN
---

cd ~/ICDE-Synthea/overlay-query-layer

python3 build_espresso_metadata_indexes.py
"""

import csv
import hashlib
import json
import time

from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from rdflib import Dataset


# ============================================================
# CONFIGURATION
# ============================================================

BASE = Path.home() / "ICDE-Synthea"

EXPERIMENTS = BASE / "experiments"

OVERLAY_LAYER = BASE / "overlay-query-layer"

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

SERVER_METADATA_FOLDER = Path(
    "ESPRESSO-pod/metaindex"
)

OVERLAY_OUTPUT = (
    OVERLAY_LAYER
    / "ESPRESSO-overlay-indexes"
)

TIMING_OUTPUT = (
    OVERLAY_LAYER
    / "ESPRESSO-metadata-build"
    / "timings"
)

TIMING_COLUMNS = [
    "level",
    "server",
    "webid",
    "index_name",
    "output_path",
    "predicates",
    "entries",
    "construction_seconds",
]


# ============================================================
# HELPERS
# ============================================================

def now_utc():
    return datetime.now(
        timezone.utc
    ).isoformat()


def elapsed(start):
    return (
        time.perf_counter() - start
    )


def webid_filename(webid):
    """
    Match the SHA-256 naming convention used by
    the existing pod-level PSO generator.
    """

    digest = hashlib.sha256(
        webid.encode("utf-8")
    ).hexdigest()

    return f"webid_{digest}"


def resource_url(
    server_root,
    server_url,
    path
):
    """
    Convert a local resource path into its CSS URL.
    """

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


def write_json_new(path, data):
    """
    Create a JSON file without overwriting
    an existing file.
    """

    path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    with path.open(
        "x",
        encoding="utf-8"
    ) as handle:

        json.dump(
            data,
            handle,
            indent=2,
            ensure_ascii=False
        )


def write_csv(
    path,
    rows,
    columns
):
    """
    Write a CSV report.
    """

    path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    with path.open(
        "w",
        newline="",
        encoding="utf-8"
    ) as handle:

        writer = csv.DictWriter(
            handle,
            fieldnames=columns
        )

        writer.writeheader()
        writer.writerows(rows)


# ============================================================
# LOAD ACTUAL WEBIDS
# ============================================================

def load_webids():
    """
    Load actual WebIDs from the identity mapping CSV.

    Uses the same supported column names as the
    pod-level PSO generator.
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
            column.strip()
            .lower()
            .replace("-", "_"): column
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

            webid = (
                row.get(webid_column) or ""
            ).strip()

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
                f"Invalid WebID URL: {webid}"
            )

    print(
        f"Loaded {len(webids)} actual WebIDs "
        "from identity CSV."
    )

    return sorted(webids)


# ============================================================
# POD DISCOVERY
# ============================================================

def discover_pods(server_root):
    """
    Discover patient and facility pods.

    Patient:
        patient_pods/<patient>/

    Facility:
        facility_pods/<category>/<facility>/

    Nested facility resources remain part of the
    containing facility pod.
    """

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
                pods.append(pod)

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
                    pods.append(pod)

    return pods


# ============================================================
# READ EXISTING POD-LEVEL PSO INDEXES
# ============================================================

def parse_pso_predicates(index_path):
    """
    Extract distinct predicate IRIs from an existing
    pod-level N-Quads PSO index.
    """

    dataset = Dataset()

    dataset.parse(
        index_path.as_posix(),
        format="nquads"
    )

    predicates = set()

    for (
        _,
        predicate,
        _,
        _
    ) in dataset.quads(
        (None, None, None, None)
    ):

        predicates.add(
            str(predicate)
        )

    return predicates


def discover_pod_indexes(
    server_root,
    server_url
):
    """
    Discover existing private and public pod-level
    PSO indexes.

    Private:
        webid_<sha256>.nq

    Public:
        public-*.nq

    Returns one entry per discovered PSO index.
    """

    entries = []

    pods = discover_pods(
        server_root
    )

    print(
        f"  Discovered {len(pods)} pod directories."
    )

    for pod in pods:

        index_dir = (
            pod
            / INDEX_FOLDER
        )

        if not index_dir.is_dir():
            continue

        pod_url = (
            resource_url(
                server_root,
                server_url,
                pod
            ).rstrip("/")
            + "/"
        )

        for index_path in sorted(
            index_dir.glob("*.nq")
        ):

            index_name = (
                index_path.stem
            )

            is_private = (
                index_name.startswith(
                    "webid_"
                )
            )

            is_public = (
                index_name.startswith(
                    "public-"
                )
            )

            if not (
                is_private
                or is_public
            ):
                continue

            index_url = resource_url(
                server_root,
                server_url,
                index_path
            )

            predicates = (
                parse_pso_predicates(
                    index_path
                )
            )

            entries.append({
                "pod": pod_url,
                "index_path": index_path,
                "index_url": index_url,
                "index_name": index_name,
                "is_private": is_private,
                "is_public": is_public,
                "predicates": predicates,
            })

    return entries


# ============================================================
# SERVER-LEVEL METADATA INDEX
# ============================================================

def create_server_index(
    server_name,
    server_root,
    server_url,
    index_name,
    webid,
    pod_entries,
    public=False
):
    """
    Create one server-level JSON metadata index.

    Private:
        Include only pod PSO indexes belonging
        to the matching WebID.

    Public:
        Include only public pod PSO indexes.

    FORMAT:

    {
        "predicates": {
            "predicateIRI": [
                {
                    "pod": "http://...",
                    "pso": "http://..."
                }
            ]
        }
    }
    """

    start = time.perf_counter()

    predicate_map = defaultdict(
        list
    )

    for entry in pod_entries:

        if public:

            if not entry["is_public"]:
                continue

        else:

            if (
                entry["index_name"]
                != index_name
            ):
                continue

        for predicate in entry["predicates"]:

            predicate_map[
                predicate
            ].append({
                "pod": entry["pod"],
                "pso": entry["index_url"],
            })

    predicates = {
        predicate: sorted(
            values,
            key=lambda item: (
                item["pod"],
                item["pso"]
            )
        )
        for predicate, values in sorted(
            predicate_map.items()
        )
    }

    output = {
        "level": (
            f"server_{server_name[1:]}"
        ),
        "name": index_name,
        "webid": (
            "public"
            if public
            else webid
        ),
        "predicates": predicates,
    }

    output_dir = (
        server_root
        / SERVER_METADATA_FOLDER
    )

    output_path = (
        output_dir
        / f"{index_name}.json"
    )

    write_json_new(
        output_path,
        output
    )

    duration = elapsed(
        start
    )

    timing = {
        "level": "server",
        "server": server_name,
        "webid": (
            "public"
            if public
            else webid
        ),
        "index_name": index_name,
        "output_path": str(
            output_path
        ),
        "predicates": len(
            predicates
        ),
        "entries": sum(
            len(values)
            for values in predicates.values()
        ),
        "construction_seconds": round(
            duration,
            9
        ),
    }

    return output, timing


# ============================================================
# OVERLAY-LEVEL METADATA INDEX
#
# UPDATED:
#
# Previously:
#   predicate -> [server metadata URLs]
#
# Now:
#   predicate -> ["S1", "S2", ...]
#
# This matches the current Case 1 JavaScript runner.
# ============================================================

def create_overlay_index(
    index_name,
    webid,
    server_indexes,
    public=False
):
    """
    Create one overlay-level JSON metadata index.

    Private:
        Predicate -> server identifiers for the
        corresponding WebID-specific indexes.

    Public:
        Predicate -> server identifiers for the
        corresponding public indexes.

    EXAMPLE:

    {
        "level": "overlay",
        "name": "public",
        "webid": "public",
        "predicates": {
            "http://example.org/predicate": [
                "S1",
                "S3"
            ]
        }
    }

    IMPORTANT:

    Server identifiers are included only when
    the server metadata actually contains
    the predicate.
    """

    start = time.perf_counter()

    predicate_map = defaultdict(
        set
    )

    for (
        server_name,
        server_index
    ) in sorted(
        server_indexes.items()
    ):

        if server_name not in SERVER_URLS:
            raise ValueError(
                f"Unknown server: {server_name}"
            )

        server_predicates = (
            server_index.get(
                "predicates",
                {}
            )
        )

        for predicate in server_predicates:

            predicate_map[
                predicate
            ].add(
                server_name
            )

    predicates = {
        predicate: sorted(
            server_names
        )
        for (
            predicate,
            server_names
        ) in sorted(
            predicate_map.items()
        )
    }

    output = {
        "level": "overlay",
        "name": index_name,
        "webid": (
            "public"
            if public
            else webid
        ),
        "predicates": predicates,
    }

    output_path = (
        OVERLAY_OUTPUT
        / f"{index_name}.json"
    )

    write_json_new(
        output_path,
        output
    )

    duration = elapsed(
        start
    )

    timing = {
        "level": "overlay",
        "server": "ALL",
        "webid": (
            "public"
            if public
            else webid
        ),
        "index_name": index_name,
        "output_path": str(
            output_path
        ),
        "predicates": len(
            predicates
        ),
        "entries": sum(
            len(values)
            for values in predicates.values()
        ),
        "construction_seconds": round(
            duration,
            9
        ),
    }

    return output, timing


# ============================================================
# PREFLIGHT
# ============================================================

def preflight(webids):
    """
    Validate server directories and refuse to
    overwrite existing metadata indexes.
    """

    for server_name in SERVER_URLS:

        server_root = (
            EXPERIMENTS
            / server_name
        )

        if not server_root.is_dir():
            raise FileNotFoundError(
                "Missing server directory: "
                f"{server_root}"
            )

    # --------------------------------------------------------
    # CHECK SERVER-LEVEL METADATA
    # --------------------------------------------------------

    for server_name in SERVER_URLS:

        server_root = (
            EXPERIMENTS
            / server_name
        )

        output_dir = (
            server_root
            / SERVER_METADATA_FOLDER
        )

        expected_names = [
            webid_filename(
                webid
            )
            for webid in webids
        ]

        expected_names.append(
            "public"
        )

        for index_name in expected_names:

            output_path = (
                output_dir
                / f"{index_name}.json"
            )

            if output_path.exists():
                raise FileExistsError(
                    "Existing server metadata index:\n"
                    f"{output_path}\n"
                    "No existing metadata will be overwritten."
                )

    # --------------------------------------------------------
    # CHECK OVERLAY-LEVEL METADATA
    # --------------------------------------------------------

    expected_names = [
        webid_filename(
            webid
        )
        for webid in webids
    ]

    expected_names.append(
        "public"
    )

    for index_name in expected_names:

        output_path = (
            OVERLAY_OUTPUT
            / f"{index_name}.json"
        )

        if output_path.exists():
            raise FileExistsError(
                "Existing overlay metadata index:\n"
                f"{output_path}\n"
                "No existing metadata will be overwritten."
            )


# ============================================================
# MAIN BUILD
# ============================================================

def build():

    total_start = (
        time.perf_counter()
    )

    print(
        "=" * 70
    )

    print(
        "ICDE-SYNTHEA: ESPRESSO HIERARCHICAL "
        "METADATA INDEX BUILDER"
    )

    print(
        "=" * 70
    )

    webids = load_webids()

    # --------------------------------------------------------
    # PREFLIGHT
    # --------------------------------------------------------

    preflight(
        webids
    )

    # --------------------------------------------------------
    # STEP 1: READ POD-LEVEL PSO INDEXES
    # --------------------------------------------------------

    scan_start = (
        time.perf_counter()
    )

    pod_entries_by_server = {}

    parsing_rows = []

    for (
        server_name,
        server_url
    ) in SERVER_URLS.items():

        server_root = (
            EXPERIMENTS
            / server_name
        )

        print(
            f"\n[{server_name}] Reading pod-level "
            "PSO indexes..."
        )

        server_start = (
            time.perf_counter()
        )

        entries = discover_pod_indexes(
            server_root,
            server_url
        )

        pod_entries_by_server[
            server_name
        ] = entries

        parsing_rows.append({
            "server": server_name,
            "indexes_read": len(
                entries
            ),
            "parsing_seconds": round(
                elapsed(server_start),
                9
            ),
        })

        print(
            "  Pod-level indexes read: "
            f"{len(entries)}"
        )

    scan_seconds = elapsed(
        scan_start
    )

    total_indexes_read = sum(
        len(entries)
        for entries in (
            pod_entries_by_server.values()
        )
    )

    if total_indexes_read == 0:
        raise RuntimeError(
            "No pod-level PSO indexes found. "
            "Complete pod-level index generation first."
        )

    # --------------------------------------------------------
    # STEP 2: SERVER-LEVEL METADATA
    # --------------------------------------------------------

    server_start = (
        time.perf_counter()
    )

    timing_rows = []

    server_indexes_by_webid = (
        defaultdict(dict)
    )

    public_server_indexes = {}

    for (
        server_name,
        server_url
    ) in SERVER_URLS.items():

        server_root = (
            EXPERIMENTS
            / server_name
        )

        pod_entries = (
            pod_entries_by_server[
                server_name
            ]
        )

        print(
            f"\n[{server_name}] Creating "
            "server-level metadata..."
        )

        # ----------------------------------------------------
        # PRIVATE WEBID-SPECIFIC SERVER INDEXES
        # ----------------------------------------------------

        for webid in webids:

            index_name = (
                webid_filename(
                    webid
                )
            )

            output, timing = (
                create_server_index(
                    server_name=server_name,
                    server_root=server_root,
                    server_url=server_url,
                    index_name=index_name,
                    webid=webid,
                    pod_entries=pod_entries,
                    public=False
                )
            )

            timing_rows.append(
                timing
            )

            server_indexes_by_webid[
                webid
            ][server_name] = output

        # ----------------------------------------------------
        # ONE PUBLIC SERVER INDEX
        # ----------------------------------------------------

        (
            public_output,
            public_timing
        ) = create_server_index(
            server_name=server_name,
            server_root=server_root,
            server_url=server_url,
            index_name="public",
            webid=None,
            pod_entries=pod_entries,
            public=True
        )

        timing_rows.append(
            public_timing
        )

        public_server_indexes[
            server_name
        ] = public_output

        print(
            "  WebID-specific indexes: "
            f"{len(webids)}"
        )

        print(
            "  Public indexes: 1"
        )

    server_seconds = elapsed(
        server_start
    )

    # --------------------------------------------------------
    # STEP 3: OVERLAY-LEVEL METADATA
    # --------------------------------------------------------

    overlay_start = (
        time.perf_counter()
    )

    print(
        "\n[OVERLAY] Creating "
        "overlay-level metadata..."
    )

    # --------------------------------------------------------
    # PRIVATE WEBID-SPECIFIC OVERLAY INDEXES
    # --------------------------------------------------------

    for webid in webids:

        index_name = (
            webid_filename(
                webid
            )
        )

        _, timing = (
            create_overlay_index(
                index_name=index_name,
                webid=webid,
                server_indexes=(
                    server_indexes_by_webid[
                        webid
                    ]
                ),
                public=False
            )
        )

        timing_rows.append(
            timing
        )

    # --------------------------------------------------------
    # ONE PUBLIC OVERLAY INDEX
    # --------------------------------------------------------

    (
        _,
        public_overlay_timing
    ) = create_overlay_index(
        index_name="public",
        webid=None,
        server_indexes=(
            public_server_indexes
        ),
        public=True
    )

    timing_rows.append(
        public_overlay_timing
    )

    overlay_seconds = elapsed(
        overlay_start
    )

    # --------------------------------------------------------
    # STEP 4: TIMING REPORTS
    # --------------------------------------------------------

    total_elapsed = elapsed(
        total_start
    )

    server_index_total = sum(
        row["construction_seconds"]
        for row in timing_rows
        if row["level"] == "server"
    )

    overlay_index_total = sum(
        row["construction_seconds"]
        for row in timing_rows
        if row["level"] == "overlay"
    )

    summary = {
        "experiment": (
            "ICDE-Synthea ESPRESSO hierarchical "
            "metadata indexes"
        ),
        "createdAtUTC": now_utc(),
        "webids": len(webids),
        "podPSOIndexesRead": (
            total_indexes_read
        ),
        "serverIndexesCreated": sum(
            row["level"] == "server"
            for row in timing_rows
        ),
        "overlayIndexesCreated": sum(
            row["level"] == "overlay"
            for row in timing_rows
        ),
        "publicServerIndexesCreated": 4,
        "publicOverlayIndexesCreated": 1,
        "timingSeconds": {
            "podPSOParsingTotal": round(
                scan_seconds,
                9
            ),
            "serverIndexConstructionTotal": round(
                server_seconds,
                9
            ),
            "overlayIndexConstructionTotal": round(
                overlay_seconds,
                9
            ),
            "allMetadataConstructionTotal": round(
                server_seconds + overlay_seconds,
                9
            ),
            "fullExecution": round(
                total_elapsed,
                9
            ),
            "sumIndividualServerIndexes": round(
                server_index_total,
                9
            ),
            "sumIndividualOverlayIndexes": round(
                overlay_index_total,
                9
            ),
        },
        "individualIndexTimings": timing_rows,
        "podPSOParsingTimings": parsing_rows,
    }

    # --------------------------------------------------------
    # STEP 5: EXPORT CSV + JSON REPORTS
    # --------------------------------------------------------

    TIMING_OUTPUT.mkdir(
        parents=True,
        exist_ok=True
    )

    write_csv(
        TIMING_OUTPUT
        / "index_construction_times.csv",
        timing_rows,
        TIMING_COLUMNS
    )

    write_csv(
        TIMING_OUTPUT
        / "pod_pso_parsing_times.csv",
        parsing_rows,
        [
            "server",
            "indexes_read",
            "parsing_seconds",
        ]
    )

    write_json_new(
        TIMING_OUTPUT
        / "index_construction_times.json",
        summary
    )

    summary_rows = [
        {
            "component": "POD_PSO_PARSING",
            "index_count": (
                total_indexes_read
            ),
            "construction_seconds": round(
                scan_seconds,
                9
            ),
        },
        {
            "component": "ALL_SERVER_INDEXES",
            "index_count": (
                summary[
                    "serverIndexesCreated"
                ]
            ),
            "construction_seconds": round(
                server_seconds,
                9
            ),
        },
        {
            "component": "ALL_OVERLAY_INDEXES",
            "index_count": (
                summary[
                    "overlayIndexesCreated"
                ]
            ),
            "construction_seconds": round(
                overlay_seconds,
                9
            ),
        },
        {
            "component": "ALL_METADATA_INDEXES",
            "index_count": (
                summary[
                    "serverIndexesCreated"
                ]
                +
                summary[
                    "overlayIndexesCreated"
                ]
            ),
            "construction_seconds": round(
                server_seconds + overlay_seconds,
                9
            ),
        },
    ]

    write_csv(
        TIMING_OUTPUT
        / "construction_summary.csv",
        summary_rows,
        [
            "component",
            "index_count",
            "construction_seconds",
        ]
    )

    # --------------------------------------------------------
    # FINAL OUTPUT
    # --------------------------------------------------------

    print(
        "\n" + "=" * 70
    )

    print(
        "ESPRESSO METADATA INDEX GENERATION COMPLETE"
    )

    print(
        "=" * 70
    )

    print(
        f"Actual WebIDs: {len(webids)}"
    )

    print(
        "Pod PSO indexes read: "
        f"{total_indexes_read}"
    )

    print(
        "Server-level indexes created: "
        f"{summary['serverIndexesCreated']}"
    )

    print(
        "Overlay-level indexes created: "
        f"{summary['overlayIndexesCreated']}"
    )

    print(
        "\nPublic server-level indexes: 4"
    )

    print(
        "Public overlay-level indexes: 1"
    )

    print(
        "\nOverlay format: predicate -> server IDs"
    )

    print(
        "Server identifiers: S1, S2, S3, S4"
    )

    print(
        "\nTIMING RESULTS"
    )

    print(
        "Pod PSO parsing: "
        f"{scan_seconds:.3f} seconds"
    )

    print(
        "Server-level construction: "
        f"{server_seconds:.3f} seconds"
    )

    print(
        "Overlay-level construction: "
        f"{overlay_seconds:.3f} seconds"
    )

    print(
        "Total metadata construction: "
        f"{server_seconds + overlay_seconds:.3f} seconds"
    )

    print(
        "Total script execution: "
        f"{total_elapsed:.3f} seconds"
    )

    print(
        f"\nTiming reports: {TIMING_OUTPUT}"
    )

    print(
        "\nOriginal RDF files: UNCHANGED"
    )

    print(
        "Original ACL files: UNCHANGED"
    )

    print(
        "Pod-level PSO indexes: UNCHANGED"
    )

    print(
        "SQLite files: NONE"
    )


def main():
    build()


if __name__ == "__main__":
    main()