import csv
import shutil
from pathlib import Path

# ============================================================
# PATHS
# ============================================================

BASE = Path.cwd()

SOURCE_ROOT = BASE / "solid_pod_simulation_v8"
FACILITY_ROOT = SOURCE_ROOT / "facility_pods"
PATIENT_ROOT = SOURCE_ROOT / "patient_pods"

MAPPING_ROOT = BASE / "server_distribution_v8"

FACILITY_CSV = MAPPING_ROOT / "facility_server_mapping.csv"
PATIENT_CSV = MAPPING_ROOT / "patient_server_mapping.csv"

OUTPUT_ROOT = BASE / "four_server_deployment"

EXPECTED = {
    "S1": {"facilities": 141, "patients": 108},
    "S2": {"facilities": 139, "patients": 133},
    "S3": {"facilities": 140, "patients": 133},
    "S4": {"facilities": 139, "patients": 126},
}


# ============================================================
# CHECK INPUTS
# ============================================================

for path in [
    FACILITY_ROOT,
    PATIENT_ROOT,
    FACILITY_CSV,
    PATIENT_CSV,
]:
    if not path.exists():
        raise FileNotFoundError(f"Missing required path: {path}")

if OUTPUT_ROOT.exists():
    raise RuntimeError(
        f"Output already exists: {OUTPUT_ROOT}\n"
        "Delete it before running this script again."
    )


# ============================================================
# CREATE FOUR SERVER DIRECTORIES
# ============================================================

for server in ["S1", "S2", "S3", "S4"]:
    (OUTPUT_ROOT / server / "facility_pods").mkdir(
        parents=True,
        exist_ok=True
    )

    (OUTPUT_ROOT / server / "patient_pods").mkdir(
        parents=True,
        exist_ok=True
    )


# ============================================================
# COPY FACILITY PODS
#
# V8 structure:
#
# facility_pods/
#     <healthcare_category>/
#         <facility_folder>/
# ============================================================

facility_counts = {s: 0 for s in EXPECTED}

with FACILITY_CSV.open(
    "r",
    newline="",
    encoding="utf-8-sig"
) as f:

    reader = csv.DictReader(f)

    for row in reader:

        server = row["assigned_server_id"].strip()
        category = row["healthcare_category"].strip()
        facility_folder = row["facility_folder"].strip()

        if server not in EXPECTED:
            raise ValueError(
                f"Unknown server {server} for {facility_folder}"
            )

        source = (
            FACILITY_ROOT
            / category
            / facility_folder
        )

        destination_category = (
            OUTPUT_ROOT
            / server
            / "facility_pods"
            / category
        )

        destination = (
            destination_category
            / facility_folder
        )

        if not source.is_dir():
            raise FileNotFoundError(
                "\nFACILITY POD NOT FOUND\n"
                f"Expected: {source}\n"
                f"Category: {category}\n"
                f"Facility: {facility_folder}\n"
                f"Server: {server}"
            )

        destination_category.mkdir(
            parents=True,
            exist_ok=True
        )

        shutil.copytree(source, destination)

        facility_counts[server] += 1


# ============================================================
# COPY PATIENT PODS
#
# V8 structure:
#
# patient_pods/
#     patient_<UUID>/
# ============================================================

patient_counts = {s: 0 for s in EXPECTED}

with PATIENT_CSV.open(
    "r",
    newline="",
    encoding="utf-8-sig"
) as f:

    reader = csv.DictReader(f)

    for row in reader:

        server = row["home_server_id"].strip()
        patient_id = row["patient_id"].strip()

        if server not in EXPECTED:
            raise ValueError(
                f"Unknown server {server} for patient {patient_id}"
            )

        patient_folder = f"patient_{patient_id}"

        source = (
            PATIENT_ROOT
            / patient_folder
        )

        destination = (
            OUTPUT_ROOT
            / server
            / "patient_pods"
            / patient_folder
        )

        if not source.is_dir():
            raise FileNotFoundError(
                "\nPATIENT POD NOT FOUND\n"
                f"Expected: {source}\n"
                f"Patient: {patient_id}\n"
                f"Server: {server}"
            )

        shutil.copytree(source, destination)

        patient_counts[server] += 1


# ============================================================
# VALIDATE COPIED DIRECTORIES FROM DISK
# ============================================================

print()
print("=" * 70)
print("FOUR-SERVER DEPLOYMENT VALIDATION")
print("=" * 70)

all_pass = True

total_facilities = 0
total_patients = 0

for server in ["S1", "S2", "S3", "S4"]:

    server_facility_root = (
        OUTPUT_ROOT / server / "facility_pods"
    )

    server_patient_root = (
        OUTPUT_ROOT / server / "patient_pods"
    )

    # Facility Pods are one level below category directories
    actual_facilities = sum(
        1
        for category in server_facility_root.iterdir()
        if category.is_dir()
        for facility in category.iterdir()
        if facility.is_dir()
    )

    actual_patients = sum(
        1
        for patient in server_patient_root.iterdir()
        if patient.is_dir()
    )

    expected_facilities = EXPECTED[server]["facilities"]
    expected_patients = EXPECTED[server]["patients"]

    facility_pass = (
        actual_facilities == expected_facilities
    )

    patient_pass = (
        actual_patients == expected_patients
    )

    if not facility_pass or not patient_pass:
        all_pass = False

    total_facilities += actual_facilities
    total_patients += actual_patients

    print()
    print(server)

    print(
        f"  Facility Pods: {actual_facilities} "
        f"/ {expected_facilities} "
        f"{'PASS' if facility_pass else 'FAIL'}"
    )

    print(
        f"  Patient Pods:  {actual_patients} "
        f"/ {expected_patients} "
        f"{'PASS' if patient_pass else 'FAIL'}"
    )

    print(
        f"  Total Pods:    "
        f"{actual_facilities + actual_patients}"
    )


# ============================================================
# FINAL VALIDATION
# ============================================================

print()
print("-" * 70)

print(f"TOTAL FACILITY PODS: {total_facilities}")
print(f"TOTAL PATIENT PODS:  {total_patients}")
print(
    f"TOTAL PODS:          "
    f"{total_facilities + total_patients}"
)

if (
    all_pass
    and total_facilities == 559
    and total_patients == 500
    and total_facilities + total_patients == 1059
):
    print()
    print("FINAL VALIDATION: PASS")
    print("Four-server deployment created successfully.")
else:
    print()
    print("FINAL VALIDATION: FAIL")

print()
print("V8 WAS NOT MODIFIED.")
print(f"Output: {OUTPUT_ROOT}")