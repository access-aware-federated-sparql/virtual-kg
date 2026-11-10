#!/usr/bin/env python3

from pathlib import Path
import json
import re
import shutil
import sys
from urllib.parse import quote

BASE = Path.home() / "ICDE-Synthea" / "synthea"

SOURCE_ROOT = BASE / "four_server_deployment"
DEST_ROOT = BASE / "four_server_rdf"

VOCAB = "http://example.org/synthea/vocab/"
DATA = "http://example.org/synthea/data/"
GRAPH = "http://example.org/synthea/graph/"

EXPECTED_PATIENTS = 35


# ============================================================
# RDF HELPERS
# ============================================================

def escape_literal(value):
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def rdf_literal(value):

    if value is None:
        return None

    if isinstance(value, bool):
        return (
            f'"{str(value).lower()}"'
            f'^^<http://www.w3.org/2001/XMLSchema#boolean>'
        )

    if isinstance(value, int):
        return (
            f'"{value}"'
            f'^^<http://www.w3.org/2001/XMLSchema#integer>'
        )

    if isinstance(value, float):
        return (
            f'"{value}"'
            f'^^<http://www.w3.org/2001/XMLSchema#decimal>'
        )

    return f'"{escape_literal(value)}"'


def safe_predicate(name):

    name = str(name).strip()

    name = re.sub(
        r"[^A-Za-z0-9_]",
        "_",
        name
    )

    name = re.sub(
        r"_+",
        "_",
        name
    ).strip("_")

    if not name:
        name = "value"

    if name[0].isdigit():
        name = "field_" + name

    return name


def safe_uri(value):
    return quote(
        str(value),
        safe="-._~"
    )


# ============================================================
# FLATTEN JSON FIELDS
# ============================================================

def flatten_json(obj, prefix=""):

    result = []

    if isinstance(obj, dict):

        for key, value in obj.items():

            new_prefix = (
                f"{prefix}_{key}"
                if prefix
                else str(key)
            )

            result.extend(
                flatten_json(
                    value,
                    new_prefix
                )
            )

    elif isinstance(obj, list):

        for value in obj:

            if isinstance(value, (dict, list)):

                result.extend(
                    flatten_json(
                        value,
                        prefix
                    )
                )

            else:

                result.append(
                    (
                        prefix or "value",
                        value
                    )
                )

    else:

        result.append(
            (
                prefix or "value",
                obj
            )
        )

    return result


# ============================================================
# READ NORMALIZED FITBIT JSON
# ============================================================

def read_records(path):

    with path.open(
        "r",
        encoding="utf-8"
    ) as f:

        data = json.load(f)

    # Normal array of records
    if isinstance(data, list):
        return data

    # Object/wrapped records
    if isinstance(data, dict):

        for key in (
            "records",
            "rows",
            "data",
            "entries",
            "observations",
        ):

            if (
                key in data
                and isinstance(data[key], list)
            ):
                return data[key]

        return [data]

    return [data]


# ============================================================
# ONE JSON FILE -> ONE NQ FILE
# ============================================================

def convert_file(
    source_json,
    output_nq,
    patient_id,
    category,
    relative_source
):

    patient_uuid = patient_id.replace(
        "patient_",
        "",
        1
    )

    patient_uri = (
        f"{DATA}Patient/"
        f"{safe_uri(patient_uuid)}"
    )

    graph_uri = (
        f"{GRAPH}"
        f"{safe_uri(patient_id)}/"
        f"{safe_uri(category)}"
    )

    records = read_records(
        source_json
    )

    output_nq.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    record_count = 0
    statement_count = 0

    with output_nq.open(
        "w",
        encoding="utf-8"
    ) as out:

        for index, record in enumerate(
            records,
            start=1
        ):

            record_count += 1

            record_uri = (
                f"{DATA}Wearable/"
                f"{safe_uri(patient_id)}/"
                f"{safe_uri(category)}/"
                f"{safe_uri(relative_source)}/"
                f"{index}"
            )

            # --------------------------------------------
            # Link wearable record to patient
            # --------------------------------------------

            out.write(
                f"<{record_uri}> "
                f"<{VOCAB}subject> "
                f"<{patient_uri}> "
                f"<{graph_uri}> .\n"
            )

            statement_count += 1

            # --------------------------------------------
            # Category
            # --------------------------------------------

            out.write(
                f"<{record_uri}> "
                f"<{VOCAB}wearableCategory> "
                f"\"{escape_literal(category)}\" "
                f"<{graph_uri}> .\n"
            )

            statement_count += 1

            # --------------------------------------------
            # Original source filename/path
            # --------------------------------------------

            out.write(
                f"<{record_uri}> "
                f"<{VOCAB}sourceFile> "
                f"\"{escape_literal(relative_source)}\" "
                f"<{graph_uri}> .\n"
            )

            statement_count += 1

            # --------------------------------------------
            # ALL Fitbit fields
            # --------------------------------------------

            if not isinstance(
                record,
                (dict, list)
            ):
                record = {
                    "value": record
                }

            for field, value in flatten_json(
                record
            ):

                if value is None:
                    continue

                predicate = safe_predicate(
                    field
                )

                obj = rdf_literal(
                    value
                )

                if obj is None:
                    continue

                out.write(
                    f"<{record_uri}> "
                    f"<{VOCAB}{predicate}> "
                    f"{obj} "
                    f"<{graph_uri}> .\n"
                )

                statement_count += 1

    if statement_count == 0:
        output_nq.unlink(
            missing_ok=True
        )

    return (
        record_count,
        statement_count
    )


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 72)
    print("FITBIT -> RDF/N-QUADS")
    print("ONE SOURCE JSON -> ONE NQ")
    print("=" * 72)

    if not SOURCE_ROOT.is_dir():

        sys.exit(
            f"\nERROR: Source missing:\n"
            f"{SOURCE_ROOT}"
        )

    if not DEST_ROOT.is_dir():

        sys.exit(
            f"\nERROR: Destination missing:\n"
            f"{DEST_ROOT}"
        )

    # ========================================================
    # FIND THE EXISTING FITBIT PATIENTS
    # ========================================================

    wearable_roots = sorted(
        SOURCE_ROOT.glob(
            "S*/patient_pods/"
            "patient_*/wearable_data"
        )
    )

    print(
        f"\nFitbit patients found: "
        f"{len(wearable_roots)}"
    )

    if len(wearable_roots) != EXPECTED_PATIENTS:

        sys.exit(
            f"\nERROR: Expected 35 Fitbit patients, "
            f"found {len(wearable_roots)}.\n"
            "Nothing was written."
        )

    # ========================================================
    # PRE-VALIDATE
    # ========================================================

    jobs = []

    source_patients = set()

    total_source_json = 0

    print("\nPRE-VALIDATING...")

    for wearable_root in wearable_roots:

        patient_id = (
            wearable_root.parent.name
        )

        relative_wearable = (
            wearable_root.relative_to(
                SOURCE_ROOT
            )
        )

        server = (
            relative_wearable.parts[0]
        )

        if server not in {
            "S1",
            "S2",
            "S3",
            "S4",
        }:

            sys.exit(
                f"\nERROR: Invalid server:\n"
                f"{wearable_root}"
            )

        if patient_id in source_patients:

            sys.exit(
                f"\nERROR: Duplicate Fitbit patient:\n"
                f"{patient_id}"
            )

        source_patients.add(
            patient_id
        )

        destination_patient = (
            DEST_ROOT
            / server
            / "patient_pods"
            / patient_id
        )

        if not destination_patient.is_dir():

            sys.exit(
                "\nERROR: Matching RDF patient "
                "does not exist:\n"
                f"{destination_patient}"
            )

        destination_wearable = (
            destination_patient
            / "wearable_data"
        )

        # Must be clean before conversion
        if destination_wearable.exists():

            sys.exit(
                "\nERROR: wearable_data already exists:\n"
                f"{destination_wearable}\n"
                "Nothing was written."
            )

        # --------------------------------------------
        # Find EVERY JSON file under this patient's
        # wearable_data.
        # --------------------------------------------

        json_files = sorted(
            wearable_root.rglob("*.json")
        )

        if not json_files:

            sys.exit(
                f"\nERROR: No Fitbit JSON files for:\n"
                f"{patient_id}"
            )

        total_source_json += len(
            json_files
        )

        for source_json in json_files:

            relative_json = (
                source_json.relative_to(
                    wearable_root
                )
            )

            # Preserve same relative structure.
            #
            # physical_activity/foo.json
            # ->
            # physical_activity/foo.nq

            output_relative = (
                relative_json.with_suffix(
                    ".nq"
                )
            )

            output_nq = (
                destination_wearable
                / output_relative
            )

            # First directory below wearable_data
            # becomes the category.
            if len(relative_json.parts) > 1:

                category = (
                    relative_json.parts[0]
                )

            else:

                category = "wearable"

            jobs.append(
                {
                    "server": server,
                    "patient_id": patient_id,
                    "source": source_json,
                    "relative":
                        relative_json.as_posix(),
                    "category": category,
                    "output": output_nq,
                }
            )

    print(
        f"Fitbit patients: "
        f"{len(source_patients)}"
    )

    print(
        f"Source JSON files: "
        f"{total_source_json:,}"
    )

    print(
        f"Expected NQ files: "
        f"{len(jobs):,}"
    )

    if len(source_patients) != 35:

        sys.exit(
            "\nERROR: Did not find 35 unique patients."
        )

    print("PRE-VALIDATION: PASS")

    # ========================================================
    # CONVERT
    # ========================================================

    print("\nCONVERTING...")

    total_records = 0
    total_statements = 0

    try:

        for i, job in enumerate(
            jobs,
            start=1
        ):

            records, statements = (
                convert_file(
                    job["source"],
                    job["output"],
                    job["patient_id"],
                    job["category"],
                    job["relative"],
                )
            )

            total_records += records
            total_statements += statements

            print(
                f"[{i}/{len(jobs)}] "
                f"{job['server']} | "
                f"{job['patient_id']} | "
                f"{job['relative']} "
                f"-> "
                f"{job['output'].name} | "
                f"{records:,} records | "
                f"{statements:,} statements"
            )

    except Exception as error:

        print("\nERROR DURING CONVERSION:")
        print(error)

        print(
            "\nRemoving ONLY Fitbit RDF generated "
            "during this run..."
        )

        for wearable_root in DEST_ROOT.glob(
            "S*/patient_pods/"
            "patient_*/wearable_data"
        ):

            if wearable_root.parent.name in source_patients:

                shutil.rmtree(
                    wearable_root
                )

        sys.exit(
            "\nConversion failed.\n"
            "Healthcare RDF was NOT modified."
        )

    # ========================================================
    # VALIDATE ONE-TO-ONE FILE MAPPING
    # ========================================================

    print("\nVALIDATING...")

    missing_outputs = []

    bad_lines = 0

    checked_statements = 0

    for job in jobs:

        output = job["output"]

        if not output.is_file():

            missing_outputs.append(
                str(output)
            )

            continue

        with output.open(
            "r",
            encoding="utf-8"
        ) as f:

            for line in f:

                if not line.strip():
                    continue

                checked_statements += 1

                if not line.rstrip().endswith(
                    " ."
                ):
                    bad_lines += 1

    generated_files = list(
        DEST_ROOT.glob(
            "S*/patient_pods/"
            "patient_*/wearable_data/**/*.nq"
        )
    )

    destination_wearables = list(
        DEST_ROOT.glob(
            "S*/patient_pods/"
            "patient_*/wearable_data"
        )
    )

    destination_patients = {
        path.parent.name
        for path in destination_wearables
    }

    extra_patients = (
        destination_patients
        - source_patients
    )

    missing_patients = (
        source_patients
        - destination_patients
    )

    # ========================================================
    # FINAL SUMMARY
    # ========================================================

    print("\n" + "=" * 72)
    print("FITBIT RDF SUMMARY")
    print("=" * 72)

    print(
        f"Source Fitbit patients:      "
        f"{len(source_patients)}"
    )

    print(
        f"Destination Fitbit patients: "
        f"{len(destination_patients)}"
    )

    print(
        f"Source JSON files:           "
        f"{total_source_json:,}"
    )

    print(
        f"Generated NQ files:          "
        f"{len(generated_files):,}"
    )

    print(
        f"Fitbit records converted:    "
        f"{total_records:,}"
    )

    print(
        f"N-Quads statements:          "
        f"{total_statements:,}"
    )

    print(
        f"Malformed N-Quad lines:      "
        f"{bad_lines:,}"
    )

    print(
        f"Missing NQ files:            "
        f"{len(missing_outputs):,}"
    )

    print(
        f"Extra Fitbit patients:       "
        f"{len(extra_patients)}"
    )

    print(
        f"Missing Fitbit patients:     "
        f"{len(missing_patients)}"
    )

    valid = (
        len(source_patients) == 35
        and
        destination_patients == source_patients
        and
        len(generated_files) == total_source_json
        and
        len(missing_outputs) == 0
        and
        bad_lines == 0
        and
        len(extra_patients) == 0
        and
        len(missing_patients) == 0
    )

    print("\n" + "=" * 72)

    if valid:

        print(
            "FITBIT RDF CONVERSION: PASS"
        )

    else:

        print(
            "FITBIT RDF CONVERSION: FAIL"
        )

    print("=" * 72)

    print("\nConfirmed:")
    print(
        "  - Same existing 35 Fitbit patients only."
    )
    print(
        "  - Other 465 patients received no Fitbit data."
    )
    print(
        "  - One source JSON -> one NQ file."
    )
    print(
        "  - Original wearable subfolder/file structure preserved."
    )
    print(
        "  - Fitbit files were NOT merged."
    )
    print(
        "  - Existing healthcare RDF was NOT modified."
    )
    print(
        "  - four_server_deployment was NOT modified."
    )
    print(
        f"  - hv: <{VOCAB}>"
    )

    print("\nDataset:")
    print(DEST_ROOT)


if __name__ == "__main__":
    main()