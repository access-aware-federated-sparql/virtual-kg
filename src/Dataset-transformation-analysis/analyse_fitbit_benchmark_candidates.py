from pathlib import Path
import csv
from collections import Counter, defaultdict
from statistics import median, mean

BASE = Path.home() / "ICDE-Synthea" / "synthea"

# Existing validated patient analysis
PATIENT_CSV = (
    BASE
    / "practitioner_access_analysis"
    / "patient_care_distribution.csv"
)

# RDF experiment dataset containing Fitbit data
EXPERIMENTS = Path.home() / "ICDE-Synthea" / "experiments"

# Output directory
OUTPUT_DIR = (
    BASE
    / "practitioner_access_analysis"
    / "fitbit_benchmark_candidates"
)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

OUTPUT_CSV = OUTPUT_DIR / "fitbit_candidates.csv"


def find_col(fieldnames, candidates):
    """
    Find a CSV column using several possible names.
    """
    normalized = {
        name.lower().strip().replace(" ", "_"): name
        for name in fieldnames
    }

    for candidate in candidates:
        key = candidate.lower().strip().replace(" ", "_")
        if key in normalized:
            return normalized[key]

    return None


# ---------------------------------------------------------------------
# 1. Find all patients that actually have wearable_data
# ---------------------------------------------------------------------

fitbit_patients = {}
duplicates = []

for server in ["S1", "S2", "S3", "S4"]:
    patient_root = EXPERIMENTS / server / "patient_pods"

    if not patient_root.exists():
        raise FileNotFoundError(
            f"Missing patient_pods directory: {patient_root}"
        )

    for patient_dir in patient_root.glob("patient_*"):
        if not patient_dir.is_dir():
            continue

        wearable_dir = patient_dir / "wearable_data"

        if wearable_dir.exists():
            patient_id = patient_dir.name.replace("patient_", "", 1)

            nq_files = list(wearable_dir.rglob("*.nq"))

            if not nq_files:
                continue

            if patient_id in fitbit_patients:
                duplicates.append(patient_id)

            categories = sorted(
                p.name
                for p in wearable_dir.iterdir()
                if p.is_dir()
            )

            fitbit_patients[patient_id] = {
                "home_server_detected": server,
                "fitbit_nq_files": len(nq_files),
                "fitbit_categories": "|".join(categories),
            }


print("=" * 78)
print("FITBIT PATIENT DISCOVERY")
print("=" * 78)
print(f"Fitbit patients found: {len(fitbit_patients)}")

if duplicates:
    print(f"WARNING: duplicate patient Pods found: {len(duplicates)}")
else:
    print("Duplicate patient Pods: 0")

if len(fitbit_patients) != 35:
    print(
        f"WARNING: expected 35 Fitbit patients, "
        f"but found {len(fitbit_patients)}"
    )
else:
    print("Expected Fitbit patient count: PASS (35)")


# ---------------------------------------------------------------------
# 2. Load existing patient care/distribution analysis
# ---------------------------------------------------------------------

with PATIENT_CSV.open(newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)

    if not reader.fieldnames:
        raise RuntimeError("patient_care_distribution.csv has no header")

    fields = reader.fieldnames

    patient_col = find_col(
        fields,
        [
            "patient_id",
            "patient",
            "patient_uuid",
        ],
    )

    server_count_col = find_col(
        fields,
        [
            "server_count",
            "num_servers",
            "number_of_servers",
            "clinical_server_count",
            "n_servers",
        ],
    )

    home_server_col = find_col(
        fields,
        [
            "home_server",
            "patient_server",
            "assigned_server",
        ],
    )

    encounter_col = find_col(
        fields,
        [
            "encounter_count",
            "encounters",
            "num_encounters",
            "number_of_encounters",
        ],
    )

    org_col = find_col(
        fields,
        [
            "organization_count",
            "organisation_count",
            "organizations",
            "organisations",
            "num_organizations",
            "num_organisations",
        ],
    )

    practitioner_col = find_col(
        fields,
        [
            "practitioner_count",
            "practitioners",
            "num_practitioners",
            "number_of_practitioners",
        ],
    )

    clinical_servers_col = find_col(
        fields,
        [
            "clinical_data_servers",
            "clinical_servers",
            "servers",
            "server_list",
        ],
    )

    required = {
        "patient": patient_col,
        "server_count": server_count_col,
        "encounters": encounter_col,
        "organisations": org_col,
        "practitioners": practitioner_col,
    }

    missing = [name for name, col in required.items() if col is None]

    if missing:
        print("\nCSV columns found:")
        for x in fields:
            print(f"  {x}")

        raise RuntimeError(
            "Could not identify required columns: "
            + ", ".join(missing)
        )

    rows = list(reader)


# ---------------------------------------------------------------------
# 3. Extract only the 35 Fitbit patients
# ---------------------------------------------------------------------

candidates = []

for row in rows:
    patient_id = row[patient_col].strip()

    if patient_id not in fitbit_patients:
        continue

    server_count = int(float(row[server_count_col]))
    encounters = int(float(row[encounter_col]))
    organisations = int(float(row[org_col]))
    practitioners = int(float(row[practitioner_col]))

    detected_home = fitbit_patients[patient_id]["home_server_detected"]

    if home_server_col and row.get(home_server_col, "").strip():
        home_server = row[home_server_col].strip()
    else:
        home_server = detected_home

    if home_server != detected_home:
        print(
            f"WARNING: home-server mismatch for {patient_id}: "
            f"CSV={home_server}, filesystem={detected_home}"
        )

    clinical_servers = (
        row.get(clinical_servers_col, "").strip()
        if clinical_servers_col
        else ""
    )

    candidates.append(
        {
            "patient_id": patient_id,
            "distribution_group": f"D{server_count}",
            "server_count": server_count,
            "home_server": home_server,
            "clinical_data_servers": clinical_servers,
            "encounters": encounters,
            "organisations": organisations,
            "practitioners": practitioners,
            "fitbit": "YES",
            "fitbit_nq_files":
                fitbit_patients[patient_id]["fitbit_nq_files"],
            "fitbit_categories":
                fitbit_patients[patient_id]["fitbit_categories"],
        }
    )


candidates.sort(
    key=lambda x: (
        x["server_count"],
        x["home_server"],
        x["encounters"],
        x["patient_id"],
    )
)


# ---------------------------------------------------------------------
# 4. Validation
# ---------------------------------------------------------------------

print("\n" + "=" * 78)
print("VALIDATION")
print("=" * 78)

print(f"Fitbit patients in filesystem : {len(fitbit_patients)}")
print(f"Matched to patient analysis   : {len(candidates)}")

candidate_ids = {x["patient_id"] for x in candidates}
missing_ids = set(fitbit_patients) - candidate_ids

if missing_ids:
    print("\nFitbit patients missing from patient analysis:")
    for patient_id in sorted(missing_ids):
        print(f"  {patient_id}")
else:
    print("All Fitbit patients matched: PASS")


# ---------------------------------------------------------------------
# 5. Availability by D group
# ---------------------------------------------------------------------

print("\n" + "=" * 78)
print("FITBIT AVAILABILITY BY CLINICAL-DISTRIBUTION GROUP")
print("=" * 78)

group_counts = Counter(x["distribution_group"] for x in candidates)

for group in ["D1", "D2", "D3", "D4"]:
    print(f"{group}: {group_counts.get(group, 0)}")


# ---------------------------------------------------------------------
# 6. D group x home-server availability
# ---------------------------------------------------------------------

print("\n" + "=" * 78)
print("FITBIT AVAILABILITY BY D-GROUP AND HOME SERVER")
print("=" * 78)

cross = defaultdict(Counter)

for x in candidates:
    cross[x["distribution_group"]][x["home_server"]] += 1

print(f"{'GROUP':<8}{'S1':>6}{'S2':>6}{'S3':>6}{'S4':>6}{'TOTAL':>8}")

for group in ["D1", "D2", "D3", "D4"]:
    counts = cross[group]
    total = sum(counts.values())

    print(
        f"{group:<8}"
        f"{counts.get('S1', 0):>6}"
        f"{counts.get('S2', 0):>6}"
        f"{counts.get('S3', 0):>6}"
        f"{counts.get('S4', 0):>6}"
        f"{total:>8}"
    )


# ---------------------------------------------------------------------
# 7. Workload characteristics per D group
# ---------------------------------------------------------------------

print("\n" + "=" * 78)
print("FITBIT CANDIDATE WORKLOAD DISTRIBUTION")
print("=" * 78)

for group in ["D1", "D2", "D3", "D4"]:
    subset = [
        x for x in candidates
        if x["distribution_group"] == group
    ]

    if not subset:
        print(f"\n{group}: no Fitbit patients")
        continue

    print(f"\n{group}: n={len(subset)}")

    for metric in ["encounters", "organisations", "practitioners"]:
        values = [x[metric] for x in subset]

        print(
            f"  {metric:<15} "
            f"min={min(values):>4} "
            f"median={median(values):>6.1f} "
            f"mean={mean(values):>6.1f} "
            f"max={max(values):>4}"
        )


# ---------------------------------------------------------------------
# 8. Print every candidate
# ---------------------------------------------------------------------

print("\n" + "=" * 78)
print("ALL FITBIT BENCHMARK CANDIDATES")
print("=" * 78)

current_group = None

for x in candidates:

    if x["distribution_group"] != current_group:
        current_group = x["distribution_group"]
        print(f"\n{current_group}")

    clinical_servers = (
        x["clinical_data_servers"]
        if x["clinical_data_servers"]
        else "(not stored in source CSV)"
    )

    print(
        f"  {x['patient_id']} "
        f"| home={x['home_server']} "
        f"| encounters={x['encounters']} "
        f"| organisations={x['organisations']} "
        f"| practitioners={x['practitioners']} "
        f"| clinical_servers={clinical_servers} "
        f"| Fitbit files={x['fitbit_nq_files']}"
    )


# ---------------------------------------------------------------------
# 9. Save candidate CSV
# ---------------------------------------------------------------------

fieldnames = [
    "patient_id",
    "distribution_group",
    "server_count",
    "home_server",
    "clinical_data_servers",
    "encounters",
    "organisations",
    "practitioners",
    "fitbit",
    "fitbit_nq_files",
    "fitbit_categories",
]

with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(candidates)


print("\n" + "=" * 78)
print("OUTPUT")
print("=" * 78)
print(OUTPUT_CSV)

if (
    len(candidates) == 35
    and group_counts.get("D1", 0) == 4
    and group_counts.get("D2", 0) == 18
    and group_counts.get("D3", 0) == 13
    and group_counts.get("D4", 0) == 0
):
    print("\nFINAL VALIDATION: PASS")
else:
    print("\nFINAL VALIDATION: CHECK RESULTS")
