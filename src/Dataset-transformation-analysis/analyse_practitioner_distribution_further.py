#!/usr/bin/env python3

from pathlib import Path
from collections import defaultdict
import csv
import statistics

# ============================================================
# PATHS
# ============================================================

BASE = Path.home() / "ICDE-Synthea" / "synthea"

PRACTITIONER_PATIENT = (
    BASE
    / "practitioner_access_analysis"
    / "practitioner_patient_mapping.csv"
)

PRACTITIONER_SUMMARY = (
    BASE
    / "practitioner_access_analysis"
    / "practitioner_summary.csv"
)

PATIENT_SERVER = (
    BASE
    / "server_distribution_v8"
    / "patient_cross_server_summary.csv"
)

OUT_DIR = (
    BASE
    / "practitioner_access_analysis"
)

OUT_FILE = (
    OUT_DIR
    / "practitioner_distribution_analysis.csv"
)


# ============================================================
# HELPERS
# ============================================================

def percentile(values, p):
    """
    Linear percentile calculation.
    p is between 0 and 100.
    """

    values = sorted(values)

    if not values:
        return None

    if len(values) == 1:
        return values[0]

    k = (len(values) - 1) * (p / 100.0)

    lower = int(k)
    upper = min(lower + 1, len(values) - 1)

    if lower == upper:
        return values[lower]

    fraction = k - lower

    return (
        values[lower]
        + (values[upper] - values[lower]) * fraction
    )


def normalize_patient_id(value):
    """
    Make patient IDs comparable across CSV files.
    """

    value = value.strip()

    if value.startswith("patient_"):
        return value[len("patient_"):]

    return value


def parse_server_list(value):
    """
    Convert values such as:

        S1|S2|S4
        S1,S2,S4
        S1;S2;S4

    into:

        {'S1', 'S2', 'S4'}
    """

    if value is None:
        return set()

    value = value.strip()

    if not value:
        return set()

    normalized = (
        value
        .replace(",", "|")
        .replace(";", "|")
    )

    servers = set()

    for item in normalized.split("|"):

        item = item.strip()

        if item in {"S1", "S2", "S3", "S4"}:
            servers.add(item)

    return servers


# ============================================================
# CHECK REQUIRED FILES
# ============================================================

print("=" * 78)
print("PRACTITIONER ACCESS + CROSS-SERVER DISTRIBUTION ANALYSIS")
print("=" * 78)

required_files = [
    PRACTITIONER_PATIENT,
    PRACTITIONER_SUMMARY,
    PATIENT_SERVER,
]

for path in required_files:

    if not path.exists():
        raise FileNotFoundError(
            f"\nRequired file not found:\n{path}"
        )

OUT_DIR.mkdir(
    parents=True,
    exist_ok=True
)


# ============================================================
# LOAD PRACTITIONER SUMMARY
# ============================================================

practitioner_summary = {}

with PRACTITIONER_SUMMARY.open(
    newline="",
    encoding="utf-8"
) as f:

    reader = csv.DictReader(f)

    for row in reader:

        practitioner_id = (
            row["practitioner_id"].strip()
        )

        practitioner_summary[
            practitioner_id
        ] = row


print(
    f"\nPractitioners loaded: "
    f"{len(practitioner_summary):,}"
)


# ============================================================
# LOAD PRACTITIONER -> PATIENT RELATIONSHIPS
# ============================================================

practitioner_patients = defaultdict(set)

with PRACTITIONER_PATIENT.open(
    newline="",
    encoding="utf-8"
) as f:

    reader = csv.DictReader(f)

    for row in reader:

        practitioner = (
            row["practitioner_id"].strip()
        )

        patient = normalize_patient_id(
            row["patient_id"]
        )

        practitioner_patients[
            practitioner
        ].add(patient)


print(
    f"Practitioner-patient mappings loaded for: "
    f"{len(practitioner_patients):,} practitioners"
)


# ============================================================
# LOAD PATIENT -> CLINICAL DATA SERVERS
# ============================================================

patient_servers = {}

with PATIENT_SERVER.open(
    newline="",
    encoding="utf-8"
) as f:

    reader = csv.DictReader(f)

    headers = reader.fieldnames or []

    print("\nPatient cross-server CSV columns:")
    print(headers)

    # These columns MUST exist in your current V8 file.
    required_columns = {
        "patient_id",
        "home_server",
        "clinical_data_servers",
        "cross_server",
    }

    missing_columns = (
        required_columns - set(headers)
    )

    if missing_columns:

        raise RuntimeError(
            "\nMissing expected columns from "
            "patient_cross_server_summary.csv:\n"
            + ", ".join(
                sorted(missing_columns)
            )
        )

    for row in reader:

        patient = normalize_patient_id(
            row["patient_id"]
        )

        clinical_servers = parse_server_list(
            row["clinical_data_servers"]
        )

        # Safety fallback:
        # Every patient should at least have its
        # reported home server represented if the
        # clinical_data_servers field were empty.
        if not clinical_servers:

            home_server = (
                row["home_server"].strip()
            )

            if home_server in {
                "S1", "S2", "S3", "S4"
            }:
                clinical_servers.add(
                    home_server
                )

        patient_servers[
            patient
        ] = clinical_servers


print(
    f"Patients with server information: "
    f"{len(patient_servers):,}"
)


# ============================================================
# VALIDATE PATIENT IDS
# ============================================================

all_practitioner_patients = set()

for patient_set in practitioner_patients.values():

    all_practitioner_patients.update(
        patient_set
    )


missing_patients = sorted(
    all_practitioner_patients
    - set(patient_servers)
)


if missing_patients:

    print(
        f"\nWARNING: "
        f"{len(missing_patients):,} "
        "practitioner-linked patients were not found "
        "in patient_cross_server_summary.csv."
    )

    print("\nFirst missing patients:")

    for patient in missing_patients[:10]:
        print(f"  {patient}")

else:

    print(
        "\nAll practitioner-linked patients have "
        "server-distribution information: PASS"
    )


# ============================================================
# VALIDATE PATIENT SERVER DISTRIBUTION
# ============================================================

patient_server_distribution = defaultdict(int)

for servers in patient_servers.values():

    patient_server_distribution[
        len(servers)
    ] += 1


print("\nPatient clinical-data server distribution:")

for server_count in sorted(
    patient_server_distribution
):

    print(
        f"  {server_count} server(s): "
        f"{patient_server_distribution[server_count]:,} patients"
    )


# This should match the independently validated dataset:
#
# 1 server  = 44
# 2 servers = 230
# 3 servers = 194
# 4 servers = 32

expected_distribution = {
    1: 44,
    2: 230,
    3: 194,
    4: 32,
}

actual_distribution = {
    key: patient_server_distribution.get(
        key,
        0
    )
    for key in expected_distribution
}


if actual_distribution == expected_distribution:

    print(
        "\nPatient server distribution validation: PASS"
    )

else:

    print(
        "\nWARNING: Patient server distribution "
        "does not match the independently "
        "validated 44/230/194/32 distribution."
    )

    print(
        f"Actual: {actual_distribution}"
    )


# ============================================================
# CALCULATE PRACTITIONER ACCESS DISTRIBUTION
# ============================================================

results = []


for practitioner, patients in (
    practitioner_patients.items()
):

    if practitioner not in practitioner_summary:

        print(
            f"WARNING: practitioner missing "
            f"from summary: {practitioner}"
        )

        continue


    summary = practitioner_summary[
        practitioner
    ]

    union_servers = set()

    patient_server_counts = []

    patients_on_1_server = 0
    patients_on_2_servers = 0
    patients_on_3_servers = 0
    patients_on_4_servers = 0

    cross_server_patients = 0


    for patient in patients:

        servers = patient_servers.get(
            patient,
            set()
        )

        server_count = len(servers)

        patient_server_counts.append(
            server_count
        )

        union_servers.update(
            servers
        )


        if server_count == 1:

            patients_on_1_server += 1

        elif server_count == 2:

            patients_on_2_servers += 1

        elif server_count == 3:

            patients_on_3_servers += 1

        elif server_count == 4:

            patients_on_4_servers += 1


        if server_count > 1:

            cross_server_patients += 1


    patient_count = len(patients)


    if patient_count:

        avg_servers_per_patient = (
            sum(patient_server_counts)
            / patient_count
        )

        cross_server_ratio = (
            cross_server_patients
            / patient_count
        )

    else:

        avg_servers_per_patient = 0.0
        cross_server_ratio = 0.0


    home_server = (
        summary
        .get("servers", "")
        .strip()
    )


    results.append({

        "practitioner_id":
            practitioner,

        "name":
            summary.get(
                "name",
                ""
            ),

        "home_server":
            home_server,

        "patient_count":
            patient_count,

        "encounter_count":
            int(
                summary["encounter_count"]
            ),

        "organization_count":
            int(
                summary["organization_count"]
            ),

        "patient_union_server_count":
            len(union_servers),

        "patient_union_servers":
            "|".join(
                sorted(union_servers)
            ),

        "patients_on_1_server":
            patients_on_1_server,

        "patients_on_2_servers":
            patients_on_2_servers,

        "patients_on_3_servers":
            patients_on_3_servers,

        "patients_on_4_servers":
            patients_on_4_servers,

        "cross_server_patients":
            cross_server_patients,

        "cross_server_ratio":
            cross_server_ratio,

        "avg_servers_per_patient":
            avg_servers_per_patient,
    })


# ============================================================
# ACCESS-SCOPE DISTRIBUTION
# ============================================================

patient_counts = [
    row["patient_count"]
    for row in results
]


print("\n" + "=" * 78)
print("PRACTITIONER PATIENT-ACCESS DISTRIBUTION")
print("=" * 78)


print(
    f"Minimum: "
    f"{min(patient_counts)}"
)

print(
    f"25th percentile: "
    f"{percentile(patient_counts, 25):.2f}"
)

print(
    f"Median: "
    f"{percentile(patient_counts, 50):.2f}"
)

print(
    f"75th percentile: "
    f"{percentile(patient_counts, 75):.2f}"
)

print(
    f"90th percentile: "
    f"{percentile(patient_counts, 90):.2f}"
)

print(
    f"95th percentile: "
    f"{percentile(patient_counts, 95):.2f}"
)

print(
    f"Maximum: "
    f"{max(patient_counts)}"
)

print(
    f"Mean: "
    f"{statistics.mean(patient_counts):.2f}"
)


# ============================================================
# PRACTITIONER COHORT SERVER COVERAGE
# ============================================================

cohort_server_distribution = defaultdict(int)


for row in results:

    cohort_server_distribution[
        row["patient_union_server_count"]
    ] += 1


print("\n" + "=" * 78)
print("PATIENT DISTRIBUTION SEEN BY PRACTITIONERS")
print("=" * 78)


for server_count in range(1, 5):

    print(
        f"Practitioners whose patient cohort "
        f"touches {server_count} server(s): "
        f"{cohort_server_distribution[server_count]:,}"
    )


# ============================================================
# CROSS-SERVER PATIENT ACCESS
# ============================================================

practitioners_with_cross_server_patient = sum(
    row["cross_server_patients"] > 0
    for row in results
)

all_patients_cross_server = sum(
    row["patient_count"] > 0
    and
    row["cross_server_patients"]
    == row["patient_count"]
    for row in results
)


print("\nPractitioner cross-server access characteristics:")

print(
    "  Practitioners with at least one "
    "cross-server patient: "
    f"{practitioners_with_cross_server_patient:,}"
)

print(
    "  Practitioners whose entire patient cohort "
    "is cross-server: "
    f"{all_patients_cross_server:,}"
)


# ============================================================
# HIGH ACCESS + HIGH DISTRIBUTION CANDIDATES
# ============================================================

print("\n" + "=" * 78)
print("HIGH ACCESS + HIGH CROSS-SERVER CANDIDATES")
print("=" * 78)


high_candidates = sorted(
    results,
    key=lambda row: (
        -row["patient_union_server_count"],
        -row["patient_count"],
        -row["cross_server_ratio"],
        -row["avg_servers_per_patient"],
        -row["encounter_count"],
        row["practitioner_id"],
    )
)


for i, row in enumerate(
    high_candidates[:20],
    1
):

    print(
        f"{i:2}. "
        f"{row['practitioner_id']} | "
        f"home={row['home_server']} | "
        f"patients={row['patient_count']} | "
        f"cross={row['cross_server_patients']} | "
        f"ratio={row['cross_server_ratio']:.2f} | "
        f"avgServers={row['avg_servers_per_patient']:.2f} | "
        f"union={row['patient_union_servers']} | "
        f"encounters={row['encounter_count']}"
    )


# ============================================================
# LOW / MEDIUM / HIGH ACCESS EXAMPLES
#
# These are descriptive candidate lists only.
# We are NOT assigning final benchmark groups yet.
# ============================================================

p25 = percentile(
    patient_counts,
    25
)

p50 = percentile(
    patient_counts,
    50
)

p75 = percentile(
    patient_counts,
    75
)

p90 = percentile(
    patient_counts,
    90
)


low_scope = [
    row
    for row in results
    if row["patient_count"] <= p25
]


medium_scope = [
    row
    for row in results
    if (
        row["patient_count"] >= p50
        and
        row["patient_count"] <= p75
    )
]


high_scope = [
    row
    for row in results
    if row["patient_count"] >= p90
]


print("\n" + "=" * 78)
print("PRELIMINARY ACCESS-SCOPE COUNTS")
print("=" * 78)

print(
    f"Low-scope candidates "
    f"(<= P25, <= {p25:.2f} patients): "
    f"{len(low_scope):,}"
)

print(
    f"Medium-scope candidates "
    f"(P50-P75, {p50:.2f}-{p75:.2f} patients): "
    f"{len(medium_scope):,}"
)

print(
    f"High-scope candidates "
    f"(>= P90, >= {p90:.2f} patients): "
    f"{len(high_scope):,}"
)


# ============================================================
# SAVE COMPLETE CSV
# ============================================================

results.sort(
    key=lambda row: (
        -row["patient_count"],
        -row["patient_union_server_count"],
        -row["cross_server_ratio"],
        row["practitioner_id"],
    )
)


fields = [
    "practitioner_id",
    "name",
    "home_server",
    "patient_count",
    "encounter_count",
    "organization_count",
    "patient_union_server_count",
    "patient_union_servers",
    "patients_on_1_server",
    "patients_on_2_servers",
    "patients_on_3_servers",
    "patients_on_4_servers",
    "cross_server_patients",
    "cross_server_ratio",
    "avg_servers_per_patient",
]


with OUT_FILE.open(
    "w",
    newline="",
    encoding="utf-8"
) as f:

    writer = csv.DictWriter(
        f,
        fieldnames=fields
    )

    writer.writeheader()

    writer.writerows(
        results
    )


# ============================================================
# FINISH
# ============================================================

print("\n" + "=" * 78)
print("OUTPUT")
print("=" * 78)

print(OUT_FILE)

print(
    "\nDONE — no RDF or existing mapping files "
    "were modified."
)
