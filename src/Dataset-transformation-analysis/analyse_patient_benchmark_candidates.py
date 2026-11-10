from pathlib import Path
import pandas as pd

BASE = Path.home() / "ICDE-Synthea"

CSV = (
    BASE
    / "synthea"
    / "practitioner_access_analysis"
    / "patient_care_distribution.csv"
)

EXPERIMENTS = BASE / "experiments"

df = pd.read_csv(CSV)

# ------------------------------------------------------------
# Find each patient's actual Patient-Pod home server
# and whether that Patient Pod contains Fitbit RDF.
# ------------------------------------------------------------

patient_info = {}

for server in ["S1", "S2", "S3", "S4"]:

    root = EXPERIMENTS / server / "patient_pods"

    for patient_dir in root.iterdir():

        if not patient_dir.is_dir():
            continue

        if not patient_dir.name.startswith("patient_"):
            continue

        patient_id = patient_dir.name.replace("patient_", "", 1)

        wearable = patient_dir / "wearable_data"

        has_fitbit = (
            wearable.exists()
            and any(wearable.rglob("*.nq"))
        )

        if patient_id in patient_info:
            raise RuntimeError(
                f"Duplicate Patient Pod: {patient_id}"
            )

        patient_info[patient_id] = {
            "home_server": server,
            "has_fitbit": has_fitbit,
        }

# ------------------------------------------------------------
# Add information to analysis dataframe
# ------------------------------------------------------------

df["home_server"] = df["patient_id"].map(
    lambda x: patient_info.get(x, {}).get("home_server")
)

df["has_fitbit"] = df["patient_id"].map(
    lambda x: patient_info.get(x, {}).get("has_fitbit", False)
)

# ------------------------------------------------------------
# Validation
# ------------------------------------------------------------

assert len(df) == 500
assert len(patient_info) == 500
assert df["home_server"].notna().all()

expected = {
    1: 44,
    2: 230,
    3: 194,
    4: 32,
}

actual = (
    df["server_count"]
    .value_counts()
    .sort_index()
    .to_dict()
)

assert actual == expected

assert int(df["has_fitbit"].sum()) == 35

print("=" * 72)
print("PATIENT BENCHMARK CANDIDATE ANALYSIS")
print("=" * 72)

print("\nTotal patients:", len(df))
print("Total Fitbit patients:", int(df["has_fitbit"].sum()))

# ------------------------------------------------------------
# 1. Candidate availability by distribution + home server
# ------------------------------------------------------------

print("\n" + "=" * 72)
print("CANDIDATES BY CLINICAL-DATA DISTRIBUTION AND HOME SERVER")
print("=" * 72)

table = pd.crosstab(
    df["server_count"],
    df["home_server"]
)

table = table.reindex(
    index=[1, 2, 3, 4],
    columns=["S1", "S2", "S3", "S4"],
    fill_value=0,
)

table["TOTAL"] = table.sum(axis=1)

print(table.to_string())

# ------------------------------------------------------------
# 2. Fitbit availability
# ------------------------------------------------------------

print("\n" + "=" * 72)
print("FITBIT CANDIDATES BY DISTRIBUTION AND HOME SERVER")
print("=" * 72)

fitbit = df[df["has_fitbit"]].copy()

fitbit_table = pd.crosstab(
    fitbit["server_count"],
    fitbit["home_server"]
)

fitbit_table = fitbit_table.reindex(
    index=[1, 2, 3, 4],
    columns=["S1", "S2", "S3", "S4"],
    fill_value=0,
)

fitbit_table["TOTAL"] = fitbit_table.sum(axis=1)

print(fitbit_table.to_string())

# ------------------------------------------------------------
# 3. Workload characteristics
# ------------------------------------------------------------

print("\n" + "=" * 72)
print("ENCOUNTER DISTRIBUTION BY CLINICAL-DATA GROUP")
print("=" * 72)

for n in [1, 2, 3, 4]:

    g = df[df["server_count"] == n]

    print(f"\n{n}-SERVER GROUP ({len(g)} patients)")

    print(
        "  encounters:"
        f" min={int(g['encounter_count'].min())},"
        f" median={g['encounter_count'].median():.1f},"
        f" mean={g['encounter_count'].mean():.1f},"
        f" max={int(g['encounter_count'].max())}"
    )

    print(
        "  organisations:"
        f" min={int(g['organization_count'].min())},"
        f" median={g['organization_count'].median():.1f},"
        f" mean={g['organization_count'].mean():.1f},"
        f" max={int(g['organization_count'].max())}"
    )

    print(
        "  practitioners:"
        f" min={int(g['practitioner_count'].min())},"
        f" median={g['practitioner_count'].median():.1f},"
        f" mean={g['practitioner_count'].mean():.1f},"
        f" max={int(g['practitioner_count'].max())}"
    )

# ------------------------------------------------------------
# 4. Show candidate patients nearest each group's median
#    encounter count, separately by home server.
# ------------------------------------------------------------

print("\n" + "=" * 72)
print("REPRESENTATIVE CANDIDATES BY GROUP AND HOME SERVER")
print("=" * 72)

for n in [1, 2, 3, 4]:

    group = df[df["server_count"] == n].copy()

    median_encounters = group["encounter_count"].median()

    group["distance_from_median"] = (
        group["encounter_count"] - median_encounters
    ).abs()

    print(
        f"\n--- {n}-SERVER GROUP "
        f"(median encounters={median_encounters:.1f}) ---"
    )

    for server in ["S1", "S2", "S3", "S4"]:

        candidates = (
            group[group["home_server"] == server]
            .sort_values(
                [
                    "distance_from_median",
                    "patient_id"
                ]
            )
            .head(3)
        )

        print(f"\n{server}:")

        if candidates.empty:
            print("  NO CANDIDATES")
            continue

        for _, row in candidates.iterrows():

            fit = "YES" if row["has_fitbit"] else "NO"

            print(
                f"  {row['patient_id']} | "
                f"enc={row['encounter_count']} | "
                f"org={row['organization_count']} | "
                f"prac={row['practitioner_count']} | "
                f"Fitbit={fit}"
            )

print("\n" + "=" * 72)
print("ANALYSIS COMPLETE — NO PATIENT SELECTION WAS CHANGED")
print("=" * 72)
