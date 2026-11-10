#!/usr/bin/env python3

from pathlib import Path
from collections import defaultdict, Counter
import csv
import re
import statistics

ROOT = (
    Path.home()
    / "ICDE-Synthea"
    / "synthea"
    / "four_server_rdf_reduced"
)

OUT_DIR = (
    Path.home()
    / "ICDE-Synthea"
    / "synthea"
    / "practitioner_access_analysis"
)

OUT_DIR.mkdir(parents=True, exist_ok=True)

OUT_FILE = OUT_DIR / "patient_care_distribution.csv"

HV = "http://example.org/synthea/vocab/"

IRI_RE = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s+\.$'
)


def last_part(uri):
    return uri.rstrip("/").split("/")[-1]


def server_from_path(path):
    return path.relative_to(ROOT).parts[0]


# ------------------------------------------------------------
# patient -> care relationships
# ------------------------------------------------------------

patients = defaultdict(
    lambda: {
        "encounters": set(),
        "practitioners": set(),
        "organizations": set(),
        "servers": set(),
    }
)

encounter_files = list(ROOT.rglob("Encounter.nq"))

print("=" * 76)
print("PATIENT CARE DISTRIBUTION ANALYSIS")
print("=" * 76)

print(f"\nEncounter.nq files: {len(encounter_files):,}")


# ------------------------------------------------------------
# Read each Encounter.nq
# ------------------------------------------------------------

for number, path in enumerate(encounter_files, 1):

    server = server_from_path(path)

    # Temporary information for encounters in this file
    encounter_info = defaultdict(
        lambda: {
            "patient": None,
            "practitioners": set(),
            "organization": None,
        }
    )

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

                encounter_info[subject]["patient"] = obj

            elif predicate == HV + "participant":

                encounter_info[subject]["practitioners"].add(obj)

            elif predicate == HV + "serviceProvider":

                encounter_info[subject]["organization"] = obj

    # Build patient-level information
    for encounter, info in encounter_info.items():

        patient = info["patient"]

        if not patient:
            continue

        p = patients[patient]

        p["encounters"].add(encounter)

        p["servers"].add(server)

        p["practitioners"].update(
            info["practitioners"]
        )

        if info["organization"]:
            p["organizations"].add(
                info["organization"]
            )

    if number % 250 == 0:
        print(
            f"  processed "
            f"{number:,}/{len(encounter_files):,}"
        )


# ------------------------------------------------------------
# Build rows
# ------------------------------------------------------------

rows = []

for patient, info in patients.items():

    rows.append({
        "patient_id":
            last_part(patient),

        "patient_uri":
            patient,

        "encounter_count":
            len(info["encounters"]),

        "practitioner_count":
            len(info["practitioners"]),

        "organization_count":
            len(info["organizations"]),

        "server_count":
            len(info["servers"]),

        "servers":
            "|".join(
                sorted(info["servers"])
            ),

        "practitioner_ids":
            "|".join(
                sorted(
                    last_part(x)
                    for x in info["practitioners"]
                )
            ),

        "organization_ids":
            "|".join(
                sorted(
                    last_part(x)
                    for x in info["organizations"]
                )
            ),
    })


rows.sort(
    key=lambda r: (
        -r["server_count"],
        -r["organization_count"],
        -r["practitioner_count"],
        -r["encounter_count"],
        r["patient_id"],
    )
)


# ------------------------------------------------------------
# Save CSV
# ------------------------------------------------------------

fields = [
    "patient_id",
    "patient_uri",
    "encounter_count",
    "practitioner_count",
    "organization_count",
    "server_count",
    "servers",
    "practitioner_ids",
    "organization_ids",
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
    writer.writerows(rows)


# ------------------------------------------------------------
# Statistics
# ------------------------------------------------------------

total = len(rows)

multi_practitioner = sum(
    r["practitioner_count"] > 1
    for r in rows
)

multi_organization = sum(
    r["organization_count"] > 1
    for r in rows
)

multi_server = sum(
    r["server_count"] > 1
    for r in rows
)

all_three = sum(
    r["practitioner_count"] > 1
    and r["organization_count"] > 1
    and r["server_count"] > 1
    for r in rows
)


practitioner_distribution = Counter(
    r["practitioner_count"]
    for r in rows
)

organization_distribution = Counter(
    r["organization_count"]
    for r in rows
)

server_distribution = Counter(
    r["server_count"]
    for r in rows
)


# ------------------------------------------------------------
# Print results
# ------------------------------------------------------------

print("\n" + "=" * 76)
print("RESULT")
print("=" * 76)

print(f"Patients analysed:                 {total:,}")

print(
    f"Patients with >1 practitioner:     "
    f"{multi_practitioner:,} "
    f"({multi_practitioner / total * 100:.2f}%)"
)

print(
    f"Patients with >1 organisation:     "
    f"{multi_organization:,} "
    f"({multi_organization / total * 100:.2f}%)"
)

print(
    f"Patients with >1 server:           "
    f"{multi_server:,} "
    f"({multi_server / total * 100:.2f}%)"
)

print(
    f"Patients with all three:           "
    f"{all_three:,} "
    f"({all_three / total * 100:.2f}%)"
)


print("\nPractitioners per patient:")

for count in sorted(practitioner_distribution):

    print(
        f"  {count:2} practitioner(s): "
        f"{practitioner_distribution[count]:,} patients"
    )


print("\nOrganisations per patient:")

for count in sorted(organization_distribution):

    print(
        f"  {count:2} organisation(s): "
        f"{organization_distribution[count]:,} patients"
    )


print("\nServers per patient:")

for count in sorted(server_distribution):

    print(
        f"  {count} server(s): "
        f"{server_distribution[count]:,} patients"
    )


practitioner_counts = [
    r["practitioner_count"]
    for r in rows
]

organization_counts = [
    r["organization_count"]
    for r in rows
]


print("\nSummary:")

print(
    f"  Practitioners/patient: "
    f"min={min(practitioner_counts)}, "
    f"mean={statistics.mean(practitioner_counts):.2f}, "
    f"median={statistics.median(practitioner_counts):.1f}, "
    f"max={max(practitioner_counts)}"
)

print(
    f"  Organisations/patient: "
    f"min={min(organization_counts)}, "
    f"mean={statistics.mean(organization_counts):.2f}, "
    f"median={statistics.median(organization_counts):.1f}, "
    f"max={max(organization_counts)}"
)


# ------------------------------------------------------------
# Best benchmark candidates
# ------------------------------------------------------------

print("\n" + "=" * 76)
print("TOP DISTRIBUTED PATIENT CANDIDATES")
print("=" * 76)

for i, r in enumerate(rows[:20], 1):

    print(
        f"{i:2}. "
        f"{r['patient_id']} | "
        f"encounters={r['encounter_count']} | "
        f"practitioners={r['practitioner_count']} | "
        f"organizations={r['organization_count']} | "
        f"servers={r['server_count']} "
        f"({r['servers']})"
    )


print("\nOutput:")
print(OUT_FILE)

print("\nDONE — RDF was not modified.")
