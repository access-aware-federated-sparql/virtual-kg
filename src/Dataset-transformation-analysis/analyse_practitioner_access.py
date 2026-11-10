#!/usr/bin/env python3

from pathlib import Path
from collections import defaultdict, Counter
import csv
import re

ROOT = Path.home() / "ICDE-Synthea" / "synthea" / "four_server_rdf_reduced"
OUT = Path.home() / "ICDE-Synthea" / "synthea" / "practitioner_access_analysis"

HV = "http://example.org/synthea/vocab/"

IRI_RE = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s+\.$'
)

LITERAL_RE = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+"(.*?)"(?:\^\^<[^>]+>)?\s+<([^>]+)>\s+\.$'
)


def last_part(uri):
    return uri.rstrip("/").split("/")[-1]


def server_from_path(path):
    rel = path.relative_to(ROOT)
    return rel.parts[0]


# ------------------------------------------------------------
# Encounter-level information
# ------------------------------------------------------------

encounters = defaultdict(
    lambda: {
        "patient": None,
        "practitioners": set(),
        "organization": None,
        "server": None,
    }
)

# Practitioner names
practitioner_names = {}

print("=" * 72)
print("PRACTITIONER ACCESS ANALYSIS")
print("=" * 72)

print("\nScanning Encounter.nq files...")

encounter_files = list(ROOT.rglob("Encounter.nq"))

print(f"Encounter.nq files: {len(encounter_files):,}")

for number, path in enumerate(encounter_files, 1):

    server = server_from_path(path)

    with path.open("r", encoding="utf-8") as f:

        for line in f:

            line = line.strip()

            if not line:
                continue

            m = IRI_RE.match(line)

            if not m:
                continue

            subject, predicate, obj, graph = m.groups()

            if predicate == HV + "subject":

                encounters[subject]["patient"] = obj
                encounters[subject]["server"] = server

            elif predicate == HV + "participant":

                encounters[subject]["practitioners"].add(obj)
                encounters[subject]["server"] = server

            elif predicate == HV + "serviceProvider":

                encounters[subject]["organization"] = obj
                encounters[subject]["server"] = server

    if number % 1000 == 0:
        print(f"  processed {number:,}/{len(encounter_files):,}")


print("\nScanning Practitioner.nq files...")

practitioner_files = list(ROOT.rglob("Practitioner.nq"))

print(f"Practitioner.nq files: {len(practitioner_files):,}")

for path in practitioner_files:

    current_names = defaultdict(list)

    with path.open("r", encoding="utf-8") as f:

        for line in f:

            line = line.strip()

            m = LITERAL_RE.match(line)

            if not m:
                continue

            subject, predicate, value, graph = m.groups()

            if predicate == HV + "name":
                current_names[subject].append(value)

    for practitioner, names in current_names.items():

        if names:
            practitioner_names[practitioner] = " ".join(names)


# ------------------------------------------------------------
# Build actual practitioner relationships
# ------------------------------------------------------------

practitioner_patients = defaultdict(set)
practitioner_servers = defaultdict(set)
practitioner_organizations = defaultdict(set)
practitioner_encounters = Counter()

practitioner_patient_encounters = Counter()

valid_encounters = 0
encounters_without_practitioner = 0
encounters_without_patient = 0


for encounter_uri, info in encounters.items():

    patient = info["patient"]
    practitioners = info["practitioners"]
    server = info["server"]
    organization = info["organization"]

    if not patient:
        encounters_without_patient += 1
        continue

    if not practitioners:
        encounters_without_practitioner += 1
        continue

    valid_encounters += 1

    for practitioner in practitioners:

        practitioner_patients[practitioner].add(patient)

        if server:
            practitioner_servers[practitioner].add(server)

        if organization:
            practitioner_organizations[practitioner].add(organization)

        practitioner_encounters[practitioner] += 1

        practitioner_patient_encounters[
            (practitioner, patient)
        ] += 1


OUT.mkdir(parents=True, exist_ok=True)


# ------------------------------------------------------------
# 1. Practitioner summary
# ------------------------------------------------------------

summary_rows = []

for practitioner in practitioner_patients:

    servers = sorted(practitioner_servers[practitioner])

    summary_rows.append({
        "practitioner_id": last_part(practitioner),
        "practitioner_uri": practitioner,
        "name": practitioner_names.get(practitioner, ""),
        "patient_count": len(practitioner_patients[practitioner]),
        "encounter_count": practitioner_encounters[practitioner],
        "organization_count": len(
            practitioner_organizations[practitioner]
        ),
        "server_count": len(servers),
        "servers": "|".join(servers),
    })


summary_rows.sort(
    key=lambda x: (
        -x["server_count"],
        -x["patient_count"],
        -x["encounter_count"],
        x["practitioner_id"],
    )
)


with (
    OUT / "practitioner_summary.csv"
).open("w", newline="", encoding="utf-8") as f:

    fields = [
        "practitioner_id",
        "practitioner_uri",
        "name",
        "patient_count",
        "encounter_count",
        "organization_count",
        "server_count",
        "servers",
    ]

    writer = csv.DictWriter(f, fieldnames=fields)

    writer.writeheader()
    writer.writerows(summary_rows)


# ------------------------------------------------------------
# 2. Practitioner-patient mapping
# ------------------------------------------------------------

with (
    OUT / "practitioner_patient_mapping.csv"
).open("w", newline="", encoding="utf-8") as f:

    writer = csv.writer(f)

    writer.writerow([
        "practitioner_id",
        "practitioner_uri",
        "patient_id",
        "patient_uri",
        "encounter_count",
    ])

    for practitioner in sorted(practitioner_patients):

        for patient in sorted(
            practitioner_patients[practitioner]
        ):

            writer.writerow([
                last_part(practitioner),
                practitioner,
                last_part(patient),
                patient,
                practitioner_patient_encounters[
                    (practitioner, patient)
                ],
            ])


# ------------------------------------------------------------
# 3. Practitioner-server mapping
# ------------------------------------------------------------

with (
    OUT / "practitioner_server_mapping.csv"
).open("w", newline="", encoding="utf-8") as f:

    writer = csv.writer(f)

    writer.writerow([
        "practitioner_id",
        "practitioner_uri",
        "server",
    ])

    for practitioner in sorted(practitioner_servers):

        for server in sorted(
            practitioner_servers[practitioner]
        ):

            writer.writerow([
                last_part(practitioner),
                practitioner,
                server,
            ])


# ------------------------------------------------------------
# 4. Practitioner-organization mapping
# ------------------------------------------------------------

with (
    OUT / "practitioner_organization_mapping.csv"
).open("w", newline="", encoding="utf-8") as f:

    writer = csv.writer(f)

    writer.writerow([
        "practitioner_id",
        "practitioner_uri",
        "organization_id",
        "organization_uri",
    ])

    for practitioner in sorted(
        practitioner_organizations
    ):

        for organization in sorted(
            practitioner_organizations[practitioner]
        ):

            writer.writerow([
                last_part(practitioner),
                practitioner,
                last_part(organization),
                organization,
            ])


# ------------------------------------------------------------
# Distribution summary
# ------------------------------------------------------------

server_count_distribution = Counter(
    row["server_count"]
    for row in summary_rows
)

patient_counts = [
    row["patient_count"]
    for row in summary_rows
]

encounter_counts = [
    row["encounter_count"]
    for row in summary_rows
]


print("\n" + "=" * 72)
print("RESULT")
print("=" * 72)

print(f"Encounter resources found:       {len(encounters):,}")
print(f"Valid practitioner encounters:   {valid_encounters:,}")
print(f"Without practitioner:            {encounters_without_practitioner:,}")
print(f"Without patient:                 {encounters_without_patient:,}")

print(
    f"\nUnique practitioners involved:   "
    f"{len(practitioner_patients):,}"
)

print(
    f"Unique patients linked:          "
    f"{len(set().union(*practitioner_patients.values())):,}"
    if practitioner_patients
    else "Unique patients linked:          0"
)

print("\nPractitioners by server coverage:")

for count in sorted(server_count_distribution):

    print(
        f"  {count} server(s): "
        f"{server_count_distribution[count]:,}"
    )

if patient_counts:

    print("\nPatients per practitioner:")

    print(
        f"  min: {min(patient_counts):,}"
    )

    print(
        f"  max: {max(patient_counts):,}"
    )

    print(
        f"  mean: "
        f"{sum(patient_counts)/len(patient_counts):.2f}"
    )


print("\nTop 20 candidates by cross-server/patient coverage:")
print("-" * 72)

for i, row in enumerate(summary_rows[:20], 1):

    print(
        f"{i:2}. "
        f"{row['practitioner_id']} | "
        f"patients={row['patient_count']} | "
        f"encounters={row['encounter_count']} | "
        f"organizations={row['organization_count']} | "
        f"servers={row['servers']}"
    )


print("\nCSV reports:")
print(OUT / "practitioner_summary.csv")
print(OUT / "practitioner_patient_mapping.csv")
print(OUT / "practitioner_server_mapping.csv")
print(OUT / "practitioner_organization_mapping.csv")

print("\nDONE — input RDF was not modified.")
