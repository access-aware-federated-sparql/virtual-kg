import csv
import glob
import json
import os
from collections import defaultdict

FACILITY_ROOT = "solid_pod_simulation_v2/facility_pods"
MAPPING_CSV = "organization_to_facility_mapping_v2.csv"

HOSPITAL_FILE = glob.glob(
    "output/fhir/hospitalInformation*.json"
)[0]

PRACTITIONER_FILE = glob.glob(
    "output/fhir/practitionerInformation*.json"
)[0]


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_resources(bundle, resource_type):
    return [
        entry.get("resource", {})
        for entry in bundle.get("entry", [])
        if entry.get("resource", {}).get("resourceType") == resource_type
    ]


def extract_reference_value(ref_obj):
    if not ref_obj:
        return None

    reference = ref_obj.get("reference", "")

    if reference:
        if "|" in reference:
            return reference.split("|")[-1]
        if "/" in reference:
            return reference.split("/")[-1]
        return reference

    identifier = ref_obj.get("identifier", {})
    value = identifier.get("value", "")

    if value:
        if "|" in value:
            return value.split("|")[-1]
        return value

    return None


def get_npi(resource):
    for identifier in resource.get("identifier", []):
        if identifier.get("system") == "http://hl7.org/fhir/sid/us-npi":
            return identifier.get("value")

    return None


def write_bundle(path, resources):
    bundle = {
        "resourceType": "Bundle",
        "type": "collection",
        "entry": [
            {"resource": r}
            for r in resources
        ]
    }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            bundle,
            f,
            indent=2,
            ensure_ascii=False
        )


# ============================================================
# ORGANIZATION -> FACILITY MAPPING
# ============================================================

org_to_facility = {}
facility_to_orgs = defaultdict(set)

with open(MAPPING_CSV, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)

    for row in reader:
        org_id = row["organization_id"].strip()
        facility_id = row["facility_id"].strip()

        org_to_facility[org_id] = facility_id
        facility_to_orgs[facility_id].add(org_id)


print("Original Organization IDs:", len(org_to_facility))
print("Physical facilities:", len(facility_to_orgs))


# ============================================================
# LOAD SYNTHEA FILES
# ============================================================

hospital_bundle = load_json(HOSPITAL_FILE)
practitioner_bundle = load_json(PRACTITIONER_FILE)

organizations = extract_resources(
    hospital_bundle,
    "Organization"
)

locations = extract_resources(
    hospital_bundle,
    "Location"
)

practitioners = extract_resources(
    practitioner_bundle,
    "Practitioner"
)

practitioner_roles = extract_resources(
    practitioner_bundle,
    "PractitionerRole"
)


print()
print("Original resources:")
print("Organization:", len(organizations))
print("Location:", len(locations))
print("Practitioner:", len(practitioners))
print("PractitionerRole:", len(practitioner_roles))


# ============================================================
# INDEX ORGANIZATIONS
# ============================================================

organization_index = {
    r["id"]: r
    for r in organizations
    if r.get("id")
}


# ============================================================
# IMPORTANT FIX:
# INDEX PRACTITIONERS BY NPI, NOT UUID
# ============================================================

practitioner_by_npi = {}

for practitioner in practitioners:

    npi = get_npi(practitioner)

    if npi:
        practitioner_by_npi[npi] = practitioner


print(
    "Practitioners indexed by NPI:",
    len(practitioner_by_npi)
)


# ============================================================
# MAP LOCATIONS TO FACILITY
# ============================================================

facility_locations = defaultdict(list)

for location in locations:

    org_id = extract_reference_value(
        location.get(
            "managingOrganization",
            {}
        )
    )

    if not org_id:
        continue

    facility_id = org_to_facility.get(org_id)

    if facility_id:
        facility_locations[
            facility_id
        ].append(location)


# ============================================================
# MAP PRACTITIONER ROLES + PRACTITIONER NPIs
# ============================================================

facility_roles = defaultdict(list)

facility_practitioner_npis = defaultdict(set)


for role in practitioner_roles:

    # --------------------------------------------------------
    # Facility organization
    # --------------------------------------------------------

    org_id = extract_reference_value(
        role.get(
            "organization",
            {}
        )
    )

    if not org_id:
        continue

    facility_id = org_to_facility.get(org_id)

    if not facility_id:
        continue

    facility_roles[
        facility_id
    ].append(role)

    # --------------------------------------------------------
    # PractitionerRole refers to Practitioner using NPI
    # --------------------------------------------------------

    practitioner_npi = extract_reference_value(
        role.get(
            "practitioner",
            {}
        )
    )

    if practitioner_npi:
        facility_practitioner_npis[
            facility_id
        ].add(practitioner_npi)


# ============================================================
# FIND FACILITY FOLDERS
# ============================================================

facility_paths = {}

for category in os.listdir(FACILITY_ROOT):

    category_path = os.path.join(
        FACILITY_ROOT,
        category
    )

    if not os.path.isdir(category_path):
        continue

    for folder in os.listdir(category_path):

        folder_path = os.path.join(
            category_path,
            folder
        )

        if not os.path.isdir(folder_path):
            continue

        if not folder.startswith("FAC"):
            continue

        facility_id = folder.split("_", 1)[0]

        facility_paths[
            facility_id
        ] = folder_path


print()
print(
    "Facility folders found:",
    len(facility_paths)
)


# ============================================================
# WRITE FILES
# ============================================================

processed = 0
missing_folders = []

organization_written = 0
location_written = 0
practitioner_written = 0
role_written = 0

facilities_with_multiple_orgs = 0
missing_practitioner_npis = set()


for facility_id, org_ids in facility_to_orgs.items():

    facility_path = facility_paths.get(
        facility_id
    )

    if not facility_path:
        missing_folders.append(
            facility_id
        )
        continue

    # --------------------------------------------------------
    # Organization
    # --------------------------------------------------------

    facility_organizations = []

    for org_id in sorted(org_ids):

        resource = organization_index.get(
            org_id
        )

        if resource:
            facility_organizations.append(
                resource
            )

    if len(facility_organizations) > 1:
        facilities_with_multiple_orgs += 1


    # --------------------------------------------------------
    # Location
    # --------------------------------------------------------

    facility_location_resources = (
        facility_locations.get(
            facility_id,
            []
        )
    )


    # --------------------------------------------------------
    # PractitionerRole
    # --------------------------------------------------------

    facility_role_resources = (
        facility_roles.get(
            facility_id,
            []
        )
    )


    # --------------------------------------------------------
    # Practitioner
    # --------------------------------------------------------

    facility_practitioners = []

    for npi in sorted(
        facility_practitioner_npis.get(
            facility_id,
            set()
        )
    ):

        practitioner = practitioner_by_npi.get(
            npi
        )

        if practitioner:
            facility_practitioners.append(
                practitioner
            )
        else:
            missing_practitioner_npis.add(
                npi
            )


    # --------------------------------------------------------
    # WRITE
    # --------------------------------------------------------

    write_bundle(
        os.path.join(
            facility_path,
            "Organization.json"
        ),
        facility_organizations
    )

    write_bundle(
        os.path.join(
            facility_path,
            "Location.json"
        ),
        facility_location_resources
    )

    write_bundle(
        os.path.join(
            facility_path,
            "Practitioner.json"
        ),
        facility_practitioners
    )

    write_bundle(
        os.path.join(
            facility_path,
            "PractitionerRole.json"
        ),
        facility_role_resources
    )


    processed += 1

    organization_written += len(
        facility_organizations
    )

    location_written += len(
        facility_location_resources
    )

    practitioner_written += len(
        facility_practitioners
    )

    role_written += len(
        facility_role_resources
    )


# ============================================================
# RESULT
# ============================================================

print()
print("======================================")
print("RESULT")
print("======================================")

print(
    "Facility folders processed:",
    processed
)

print(
    "Missing facility folders:",
    len(missing_folders)
)

print(
    "Facilities with multiple original Organization IDs:",
    facilities_with_multiple_orgs
)

print()
print("FHIR resources placed:")

print(
    "Organization:",
    organization_written
)

print(
    "Location:",
    location_written
)

print(
    "Practitioner:",
    practitioner_written
)

print(
    "PractitionerRole:",
    role_written
)

print()
print(
    "Missing Practitioner NPIs:",
    len(missing_practitioner_npis)
)

if missing_practitioner_npis:

    for npi in sorted(
        missing_practitioner_npis
    ):
        print("Missing NPI:", npi)


if missing_folders:

    print()
    print("Missing facility IDs:")

    for facility_id in missing_folders:
        print(facility_id)