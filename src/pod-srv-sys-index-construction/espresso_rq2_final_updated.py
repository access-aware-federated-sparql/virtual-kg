#!/usr/bin/env python3

"""
ESPRESSO FOUR-STRATEGY FAIR COMPARISON
=====================================

Strategies:
    Baseline
    Case 1
    Case 2
    Case 3 (HDT)

Scales:
    100, 250, 500, 750, 1059

INPUT:
    Exactly 20 CSV files directly inside overlay-query-layer/.

    No recursive searching.
    No duplicate input files.
    No reading from BaselineResults.
    No reading from ESPRESSO-metadata-build.

FAIRNESS:
    Match using:
        federationScale
        role
        identity
        query
        repetition

    Include a configuration only if:
        - All four strategies have the configuration.
        - Repetition identifiers match.
        - Execution outcomes are valid.
        - All four strategies return identical result counts.

VALID EMPTY-RESULT OUTCOME:
    status = no_sources_selected
    results = 0

    This is valid because selecting zero relevant sources
    can be the correct source-selection result.

    Selecting different numbers of sources is allowed.
    Only query-result equivalence is required.

METRICS:
    Results        -> results
    Acc. (ms)      -> accessCheckMs
    SS (ms)        -> sourceSelectionMs
    Com. (ms)      -> comunicaMs
    Total (ms)     -> totalMs
    Req.           -> httpRequests
    RDF res.       -> httpRequests (legacy request-count proxy)
    RDF MB         -> rdfMBTransferred
    RAM (MB)       -> peakMemoryMB

    CPU (s):
        Baseline:
            (cpuUserMs + cpuSystemMs) / 1000

        Cases 1, 2, 3:
            cpuTotalMs / 1000, when available
            otherwise:
            (cpuUserMs + cpuSystemMs) / 1000

IMPORTANT:
    Timing columns are read directly.
    totalMs is NEVER calculated by adding other timings.

OUTPUT:
    espresso_four_strategy_results/

DEPENDENCIES:
    Python standard library only.
"""

import argparse
import csv
import math
import re
import sys

from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean


# ============================================================
# 1. CONFIGURATION
# ============================================================

SCALES = [
    100,
    250,
    500,
    750,
    1059,
]

STRATEGIES = [
    "Baseline",
    "Case 1",
    "Case 2",
    "Case 3",
]

STRATEGY_FILENAME_PREFIX = {
    "Baseline": "experiment_baseline_scale_",
    "Case 1": "experiment_case1_scale_",
    "Case 2": "experiment_case2_scale_",
    "Case 3": "experiment_case3_scale_",
}

SUCCESS_STATUSES = {
    "success",
    "successful",
    "succeeded",
    "pass",
    "passed",
    "ok",
    "complete",
    "completed",
    "true",
    "1",
}

EMPTY_RESULT_STATUS = "no_sources_selected"

ROLES = [
    "Patient",
    "Practitioner",
    "Researcher",
]

REQUIRE_ALL_METRICS = False


# ============================================================
# 2. EXACT CSV COLUMN MAPPINGS
# ============================================================

COMMON_REQUIRED_COLUMNS = [
    "repetition",
    "federationScale",
    "role",
    "identity",
    "query",
    "results",
    "status",
    "accessCheckMs",
    "sourceSelectionMs",
    "comunicaMs",
    "totalMs",
    "httpRequests",
    "rdfMBTransferred",
    "peakMemoryMB",
    "cpuUserMs",
    "cpuSystemMs",
]

METRIC_COLUMNS = {
    "Results": "results",
    "Acc. (ms)": "accessCheckMs",
    "SS (ms)": "sourceSelectionMs",
    "Com. (ms)": "comunicaMs",
    "Total (ms)": "totalMs",
    "Req.": "httpRequests",
    "RDF res.": "httpRequests",
    "RDF MB": "rdfMBTransferred",
    "RAM (MB)": "peakMemoryMB",
}

METRIC_NAMES = [
    "Results",
    "Acc. (ms)",
    "SS (ms)",
    "Com. (ms)",
    "Total (ms)",
    "Req.",
    "RDF res.",
    "RDF MB",
    "RAM (MB)",
    "CPU (s)",
]

REDUCTION_METRICS = [
    "Acc. (ms)",
    "SS (ms)",
    "Com. (ms)",
    "Total (ms)",
    "Req.",
    "RDF res.",
    "RDF MB",
    "RAM (MB)",
    "CPU (s)",
]


# ============================================================
# 3. BASIC HELPERS
# ============================================================

def clean(value):
    if value is None:
        return ""

    return str(value).strip()


def parse_number(value):
    value = clean(value)

    if not value:
        return None

    try:
        result = float(value)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(result):
        return None

    return result


def parse_integer(value):
    number = parse_number(value)

    if number is None:
        return None

    if not number.is_integer():
        return None

    return int(number)


def average(values):
    valid = [
        value
        for value in values
        if value is not None
        and math.isfinite(value)
    ]

    if not valid:
        return None

    return mean(valid)


def normalize_role(value):
    value = clean(value).lower()

    if value.startswith("patient"):
        return "Patient"

    if value.startswith("practitioner"):
        return "Practitioner"

    if value.startswith("researcher"):
        return "Researcher"

    return value.title()


def normalize_query(value):
    value = clean(value).upper()

    match = re.fullmatch(
        r"(?:Q|QUERY)[_\-\s]*0*(\d+)",
        value,
    )

    if match:
        return f"Q{int(match.group(1)):02d}"

    return value


def normalize_status(value):
    return clean(value).lower()


# ============================================================
# 4. CORRECT SUCCESS VALIDATION
# ============================================================

def is_success(status, result_count):
    """
    A normal successful status is valid.

    no_sources_selected is ALSO valid when results = 0.

    This handles the source-pruning optimization correctly.

    Example:

        Baseline:
            selectedSources = 100
            results = 0
            status = success

        Case 1:
            selectedSources = 0
            results = 0
            status = no_sources_selected

    Both are valid.

    Source counts do not need to match.
    Result counts must match.
    """

    status = normalize_status(status)

    if status in SUCCESS_STATUSES:
        return True

    if status == EMPTY_RESULT_STATUS:
        return result_count == 0

    return False


def write_csv(path, rows, columns):
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with path.open(
        "w",
        newline="",
        encoding="utf-8",
    ) as handle:

        writer = csv.DictWriter(
            handle,
            fieldnames=columns,
            extrasaction="ignore",
        )

        writer.writeheader()
        writer.writerows(rows)


def write_text(path, content):
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    path.write_text(
        content,
        encoding="utf-8",
    )


def latex_value(value):
    if value is None:
        return "--"

    return f"{value:.2f}"


# ============================================================
# 5. EXACT INPUT FILE DISCOVERY
# ============================================================

def get_input_file(input_dir, strategy, scale):
    """
    Read files ONLY from the input directory.

    Never search subdirectories.
    """

    prefix = STRATEGY_FILENAME_PREFIX[strategy]

    filename = f"{prefix}{scale}.csv"

    return input_dir / filename


def verify_input_files(input_dir):
    files = {}
    missing = []

    for scale in SCALES:

        for strategy in STRATEGIES:

            path = get_input_file(
                input_dir,
                strategy,
                scale,
            )

            if path.is_file():
                files[(scale, strategy)] = path
            else:
                missing.append(path)

    if missing:

        print("\nERROR: Missing input files:\n")

        for path in missing:
            print(path)

        sys.exit(1)

    return files


# ============================================================
# 6. CPU MEASUREMENT
# ============================================================

def get_cpu_seconds(row, strategy):
    """
    Baseline:
        cpuUserMs + cpuSystemMs

    Cases 1-3:
        cpuTotalMs if available

    Convert milliseconds to seconds.
    """

    if strategy != "Baseline":

        cpu_total = parse_number(
            row.get("cpuTotalMs")
        )

        if cpu_total is not None:
            return cpu_total / 1000.0

    cpu_user = parse_number(
        row.get("cpuUserMs")
    )

    cpu_system = parse_number(
        row.get("cpuSystemMs")
    )

    if cpu_user is None or cpu_system is None:
        return None

    return (
        cpu_user + cpu_system
    ) / 1000.0


# ============================================================
# 7. EXTRACT METRICS
# ============================================================

def extract_metrics(row, strategy):
    metrics = {}

    for metric_name, column_name in METRIC_COLUMNS.items():

        metrics[metric_name] = parse_number(
            row.get(column_name)
        )

    metrics["CPU (s)"] = get_cpu_seconds(
        row,
        strategy,
    )

    return metrics


# ============================================================
# 8. READ EXPERIMENT CSV
# ============================================================

def read_experiment_csv(path, strategy, scale):
    records = []

    with path.open(
        "r",
        encoding="utf-8-sig",
        newline="",
    ) as handle:

        first_line = handle.readline()
        handle.seek(0)

        delimiter = (
            "\t"
            if first_line.count("\t") > first_line.count(",")
            else ","
        )

        reader = csv.DictReader(
            handle,
            delimiter=delimiter,
        )

        headers = reader.fieldnames or []

        missing_columns = [
            column
            for column in COMMON_REQUIRED_COLUMNS
            if column not in headers
        ]

        if missing_columns:

            raise ValueError(
                f"\nCSV: {path}\n"
                f"Missing columns: {missing_columns}\n"
                f"Available columns: {headers}"
            )

        for line_number, row in enumerate(
            reader,
            start=2,
        ):

            row_scale = parse_integer(
                row.get("federationScale")
            )

            if row_scale != scale:

                raise ValueError(
                    f"{path}, line {line_number}: "
                    f"Expected scale {scale}, "
                    f"found {row_scale}"
                )

            role = normalize_role(
                row.get("role")
            )

            identity = clean(
                row.get("identity")
            )

            query = normalize_query(
                row.get("query")
            )

            repetition = parse_integer(
                row.get("repetition")
            )

            status = normalize_status(
                row.get("status")
            )

            result_count = parse_integer(
                row.get("results")
            )

            metrics = extract_metrics(
                row,
                strategy,
            )

            records.append({
                "scale": scale,
                "strategy": strategy,
                "role": role,
                "identity": identity,
                "query": query,
                "repetition": repetition,
                "status": status,
                "results": result_count,
                "metrics": metrics,
                "source_file": str(path),
                "source_line": line_number,
            })

    return records


# ============================================================
# 9. GROUP CONFIGURATIONS
# ============================================================

def configuration_key(record):
    return (
        record["scale"],
        record["role"],
        record["identity"],
        record["query"],
    )


def group_records(records):
    grouped = defaultdict(
        lambda: defaultdict(list)
    )

    for record in records:

        key = configuration_key(record)

        grouped[key][
            record["strategy"]
        ].append(record)

    return grouped


# ============================================================
# 10. VALIDATE ONE STRATEGY
# ============================================================

def validate_strategy_records(records):
    """
    Validate all repetitions for one strategy.

    IMPORTANT:
        no_sources_selected + zero results is valid.

    Do not exclude a configuration just because
    zero sources were selected.
    """

    if not records:
        return False, "missing_records", {}

    repetitions = {}

    for record in records:

        rep = record["repetition"]

        if rep is None:

            return (
                False,
                "invalid_repetition",
                {},
            )

        if rep in repetitions:

            return (
                False,
                f"duplicate_repetition_{rep}",
                {},
            )

        if record["results"] is None:

            return (
                False,
                "invalid_results",
                {},
            )

        # CORRECTED STATUS VALIDATION
        if not is_success(
            record["status"],
            record["results"],
        ):

            return (
                False,
                f"invalid_status_{record['status']}",
                {},
            )

        if REQUIRE_ALL_METRICS:

            missing_metrics = [
                metric
                for metric in METRIC_NAMES
                if record["metrics"][metric] is None
            ]

            if missing_metrics:

                return (
                    False,
                    "missing_metrics:"
                    + ",".join(missing_metrics),
                    {},
                )

        repetitions[rep] = record

    return True, "valid", repetitions


# ============================================================
# 11. MATCH ALL FOUR STRATEGIES
# ============================================================

def match_four_strategies(records):
    """
    Match configurations across all four strategies.

    Patients/practitioners:
        Valid zero-result queries are included.

    Researchers:
        Strict result-count matching is preserved.

    For every role:
        Same scale.
        Same identity.
        Same query.
        Same repetitions.
        Valid statuses.
        Identical result counts.

    Different selected-source counts are allowed.
    """

    grouped = group_records(records)

    matched = []
    audit = []

    for key in sorted(grouped):

        scale, role, identity, query = key

        strategies = grouped[key]

        audit_row = {
            "scale": scale,
            "role": role,
            "identity": identity,
            "query": query,
            "included": "NO",
            "reason": "",
            "baseline_rows": len(
                strategies.get("Baseline", [])
            ),
            "case1_rows": len(
                strategies.get("Case 1", [])
            ),
            "case2_rows": len(
                strategies.get("Case 2", [])
            ),
            "case3_rows": len(
                strategies.get("Case 3", [])
            ),
            "matched_repetitions": 0,
        }

        # --------------------------------------------
        # Check all four strategies exist.
        # --------------------------------------------

        missing = [
            strategy
            for strategy in STRATEGIES
            if strategy not in strategies
        ]

        if missing:

            audit_row["reason"] = (
                "missing_strategy:"
                + ",".join(missing)
            )

            audit.append(audit_row)
            continue

        # --------------------------------------------
        # Validate each strategy.
        # --------------------------------------------

        validated = {}
        failure_reason = None

        for strategy in STRATEGIES:

            valid, reason, repetitions = (
                validate_strategy_records(
                    strategies[strategy]
                )
            )

            if not valid:

                failure_reason = (
                    f"{strategy}:{reason}"
                )

                break

            validated[strategy] = repetitions

        if failure_reason:

            audit_row["reason"] = failure_reason

            audit.append(audit_row)
            continue

        # --------------------------------------------
        # Compare repetition identifiers.
        # --------------------------------------------

        baseline_reps = set(
            validated["Baseline"]
        )

        repetition_mismatch = any(
            set(validated[strategy]) != baseline_reps
            for strategy in STRATEGIES
        )

        if repetition_mismatch:

            audit_row["reason"] = (
                "repetition_set_mismatch"
            )

            audit.append(audit_row)
            continue

        # --------------------------------------------
        # Compare actual result counts.
        # --------------------------------------------

        results_match = True

        for repetition in sorted(baseline_reps):

            counts = [
                validated[strategy][repetition]["results"]
                for strategy in STRATEGIES
            ]

            if len(set(counts)) != 1:
                results_match = False
                break

        if not results_match:

            audit_row["reason"] = (
                "result_count_mismatch"
            )

            audit.append(audit_row)
            continue

        # --------------------------------------------
        # Configuration is valid.
        # --------------------------------------------

        audit_row["included"] = "YES"
        audit_row["reason"] = "matched"

        audit_row["matched_repetitions"] = len(
            baseline_reps
        )

        audit.append(audit_row)

        # --------------------------------------------
        # Calculate configuration means.
        # --------------------------------------------

        for strategy in STRATEGIES:

            strategy_repetitions = [
                validated[strategy][rep]
                for rep in sorted(baseline_reps)
            ]

            metric_means = {}

            for metric in METRIC_NAMES:

                metric_means[metric] = average([
                    record["metrics"][metric]
                    for record in strategy_repetitions
                ])

            matched.append({
                "scale": scale,
                "role": role,
                "identity": identity,
                "query": query,
                "strategy": strategy,
                "repetitions": len(
                    strategy_repetitions
                ),
                **metric_means,
            })

    return matched, audit


# ============================================================
# 12. AGGREGATE MEANS
# ============================================================

def summarize_rows(
    rows,
    scale,
    strategy,
    role_label,
    query_label,
):
    """
    Average repetitions per configuration first.

    Then average configurations within the group.
    """

    if not rows:
        return None

    summary = {
        "scale": scale,
        "role": role_label,
        "query": query_label,
        "strategy": strategy,
        "configurations": len(rows),
        "executions": sum(
            row["repetitions"]
            for row in rows
        ),
    }

    for metric in METRIC_NAMES:

        summary[metric] = average([
            row[metric]
            for row in rows
        ])

    return summary


def build_mean_tables(matched):

    patient_practitioner = []
    researchers = []
    role_level = []
    query_level = []

    for scale in SCALES:

        for strategy in STRATEGIES:

            current = [
                row
                for row in matched
                if row["scale"] == scale
                and row["strategy"] == strategy
            ]

            # ----------------------------------------
            # Patients and practitioners: Q01-Q08
            # ----------------------------------------

            pp = [
                row
                for row in current
                if row["role"] in {
                    "Patient",
                    "Practitioner",
                }
                and row["query"] in {
                    f"Q{i:02d}"
                    for i in range(1, 9)
                }
            ]

            summary = summarize_rows(
                pp,
                scale,
                strategy,
                "Patient+Practitioner",
                "Q01-Q08",
            )

            if summary:
                patient_practitioner.append(summary)

            # ----------------------------------------
            # Researchers: Q09-Q12
            # ----------------------------------------

            research = [
                row
                for row in current
                if row["role"] == "Researcher"
                and row["query"] in {
                    "Q09",
                    "Q10",
                    "Q11",
                    "Q12",
                }
            ]

            summary = summarize_rows(
                research,
                scale,
                strategy,
                "Researcher",
                "Q09-Q12",
            )

            if summary:
                researchers.append(summary)

            # ----------------------------------------
            # Individual role means
            # ----------------------------------------

            for role in ROLES:

                role_rows = [
                    row
                    for row in current
                    if row["role"] == role
                ]

                summary = summarize_rows(
                    role_rows,
                    scale,
                    strategy,
                    role,
                    "All",
                )

                if summary:
                    role_level.append(summary)

            # ----------------------------------------
            # Individual query means
            # ----------------------------------------

            for role, query_numbers in [
                ("Patient", range(1, 5)),
                ("Practitioner", range(5, 9)),
                ("Researcher", range(9, 13)),
            ]:

                for number in query_numbers:

                    query = f"Q{number:02d}"

                    selected = [
                        row
                        for row in current
                        if row["role"] == role
                        and row["query"] == query
                    ]

                    summary = summarize_rows(
                        selected,
                        scale,
                        strategy,
                        role,
                        query,
                    )

                    if summary:
                        query_level.append(summary)

    return {
        "patient_practitioner": patient_practitioner,
        "researchers": researchers,
        "role_level": role_level,
        "query_level": query_level,
    }


# ============================================================
# 13. PERCENTAGE REDUCTIONS
# ============================================================

def calculate_reduction(baseline, case):
    """
    Positive = improvement compared with Baseline.

    Negative = increase compared with Baseline.

    Undefined when Baseline is zero.
    """

    if baseline is None or case is None:
        return None

    if baseline == 0:
        return None

    return (
        (baseline - case) / baseline
    ) * 100.0


def build_reduction_table(mean_rows):

    index = {}

    for row in mean_rows:

        key = (
            row["scale"],
            row["role"],
            row["query"],
            row["strategy"],
        )

        index[key] = row

    reductions = []

    for row in mean_rows:

        if row["strategy"] == "Baseline":
            continue

        baseline_key = (
            row["scale"],
            row["role"],
            row["query"],
            "Baseline",
        )

        baseline = index.get(baseline_key)

        if baseline is None:
            continue

        result = {
            "scale": row["scale"],
            "role": row["role"],
            "query": row["query"],
            "strategy": row["strategy"],
            "configurations": row["configurations"],
        }

        for metric in REDUCTION_METRICS:

            column = f"{metric} reduction (%)"

            result[column] = calculate_reduction(
                baseline[metric],
                row[metric],
            )

        reductions.append(result)

    return reductions


# ============================================================
# 14. OUTPUT COLUMNS
# ============================================================

MEAN_COLUMNS = [
    "scale",
    "role",
    "query",
    "strategy",
    "configurations",
    "executions",
    *METRIC_NAMES,
]

REDUCTION_COLUMNS = [
    "scale",
    "role",
    "query",
    "strategy",
    "configurations",
    *[
        f"{metric} reduction (%)"
        for metric in REDUCTION_METRICS
    ],
]

MATCHED_COLUMNS = [
    "scale",
    "role",
    "identity",
    "query",
    "strategy",
    "repetitions",
    *METRIC_NAMES,
]

AUDIT_COLUMNS = [
    "scale",
    "role",
    "identity",
    "query",
    "included",
    "reason",
    "baseline_rows",
    "case1_rows",
    "case2_rows",
    "case3_rows",
    "matched_repetitions",
]


# ============================================================
# 15. SAVE CSV RESULTS
# ============================================================

def save_csv_results(output_dir, matched, audit, tables):

    write_csv(
        output_dir / "matched_configurations.csv",
        matched,
        MATCHED_COLUMNS,
    )

    write_csv(
        output_dir / "matching_audit.csv",
        audit,
        AUDIT_COLUMNS,
    )

    for name, rows in tables.items():

        write_csv(
            output_dir / f"{name}_means.csv",
            rows,
            MEAN_COLUMNS,
        )

        reductions = build_reduction_table(rows)

        write_csv(
            output_dir / f"{name}_reductions.csv",
            reductions,
            REDUCTION_COLUMNS,
        )


# ============================================================
# 16. LATEX OUTPUT
# ============================================================

def latex_mean_rows(rows):

    lines = []

    for row in rows:

        values = [
            str(row["scale"]),
            row["strategy"],
            str(row["configurations"]),
        ]

        for metric in METRIC_NAMES:

            values.append(
                latex_value(row[metric])
            )

        lines.append(
            " & ".join(values) + r" \\"
        )

    return "\n".join(lines) + "\n"


def latex_reduction_rows(rows):

    lines = []

    for row in rows:

        values = [
            str(row["scale"]),
            row["strategy"],
        ]

        for metric in REDUCTION_METRICS:

            column = f"{metric} reduction (%)"

            values.append(
                latex_value(row[column])
            )

        lines.append(
            " & ".join(values) + r" \\"
        )

    return "\n".join(lines) + "\n"


def latex_query_rows(rows):

    lines = []

    for row in rows:

        values = [
            str(row["scale"]),
            row["role"],
            row["query"],
            row["strategy"],
        ]

        for metric in METRIC_NAMES:

            values.append(
                latex_value(row[metric])
            )

        lines.append(
            " & ".join(values) + r" \\"
        )

    return "\n".join(lines) + "\n"


def save_latex_results(output_dir, tables):

    for name, rows in tables.items():

        write_text(
            output_dir / f"latex_{name}_means.tex",
            latex_mean_rows(rows),
        )

        reductions = build_reduction_table(rows)

        write_text(
            output_dir / f"latex_{name}_reductions.tex",
            latex_reduction_rows(reductions),
        )

    query_rows = tables["query_level"]

    for scale in SCALES:

        selected = [
            row
            for row in query_rows
            if row["scale"] == scale
        ]

        write_text(
            output_dir / f"latex_queries_{scale}.tex",
            latex_query_rows(selected),
        )


# ============================================================
# 17. MATCHING AUDIT REPORT
# ============================================================

def build_audit_report(audit):

    lines = [
        "ESPRESSO FOUR-STRATEGY MATCHING AUDIT",
        "=" * 72,
        "",
    ]

    total_matched = sum(
        row["included"] == "YES"
        for row in audit
    )

    total_excluded = sum(
        row["included"] == "NO"
        for row in audit
    )

    lines.append(
        f"Matched configurations: {total_matched}"
    )

    lines.append(
        f"Excluded configurations: {total_excluded}"
    )

    lines.append("")

    reasons = Counter(
        row["reason"]
        for row in audit
        if row["included"] == "NO"
    )

    lines.append("EXCLUSION REASONS")
    lines.append("-" * 72)

    if reasons:

        for reason, count in reasons.most_common():

            lines.append(
                f"{count:5d}  {reason}"
            )

    else:
        lines.append("None")

    lines.append("")
    lines.append("MATCHED CONFIGURATIONS BY SCALE AND ROLE")
    lines.append("-" * 72)

    for scale in SCALES:

        for role in ROLES:

            selected = [
                row
                for row in audit
                if row["scale"] == scale
                and row["role"] == role
            ]

            matched = sum(
                row["included"] == "YES"
                for row in selected
            )

            excluded = sum(
                row["included"] == "NO"
                for row in selected
            )

            lines.append(
                f"Scale {scale:4d} | "
                f"{role:15s} | "
                f"Matched {matched:4d} | "
                f"Excluded {excluded:4d}"
            )

    lines.append("")
    lines.append("RESEARCHER QUERY MATCHING")
    lines.append("-" * 72)

    for scale in SCALES:

        for query in [
            "Q09",
            "Q10",
            "Q11",
            "Q12",
        ]:

            count = sum(
                row["included"] == "YES"
                and row["scale"] == scale
                and row["role"] == "Researcher"
                and row["query"] == query
                for row in audit
            )

            lines.append(
                f"Scale {scale:4d} | "
                f"{query} | "
                f"{count} matched configurations"
            )

    lines.append("")
    lines.append("METHODOLOGY")
    lines.append("-" * 72)

    lines.append(
        "Matching key: scale, role, identity, query."
    )

    lines.append(
        "All four strategies must have matching "
        "repetition identifiers."
    )

    lines.append(
        "All strategies must have valid execution outcomes."
    )

    lines.append(
        "no_sources_selected with zero results is "
        "treated as a valid empty-result outcome."
    )

    lines.append(
        "Different selected-source counts are allowed."
    )

    lines.append(
        "Result counts must match across all "
        "four strategies for each repetition."
    )

    lines.append(
        "Repetitions are averaged per configuration."
    )

    lines.append(
        "Configuration means are averaged "
        "within each reporting group."
    )

    lines.append(
        "Timing metrics are taken directly "
        "from the original CSV columns."
    )

    lines.append(
        "CPU values are converted from "
        "milliseconds to seconds."
    )

    lines.append(
        "RDF res. uses httpRequests as a legacy "
        "request-count proxy, not an independent "
        "RDF-resource measurement."
    )

    return "\n".join(lines) + "\n"


# ============================================================
# 18. PRINT MATCHING SUMMARY
# ============================================================

def print_matching_summary(audit):

    matched = [
        row
        for row in audit
        if row["included"] == "YES"
    ]

    excluded = [
        row
        for row in audit
        if row["included"] == "NO"
    ]

    print()
    print("MATCHING RESULTS")
    print("-" * 72)

    print(
        f"Matched configurations: {len(matched)}"
    )

    print(
        f"Excluded configurations: {len(excluded)}"
    )

    print()
    print("EXCLUSION REASONS")
    print("-" * 72)

    reasons = Counter(
        row["reason"]
        for row in excluded
    )

    if not reasons:
        print("None")

    for reason, count in reasons.most_common():

        print(
            f"{count:5d} | {reason}"
        )

    print()
    print("MATCHED CONFIGURATIONS BY SCALE")
    print("-" * 72)

    for scale in SCALES:

        for role in ROLES:

            count = sum(
                row["scale"] == scale
                and row["role"] == role
                for row in matched
            )

            print(
                f"Scale {scale:4d} | "
                f"{role:15s} | "
                f"{count:4d} matched"
            )


# ============================================================
# 19. MAIN
# ============================================================

def main():

    parser = argparse.ArgumentParser(
        description=(
            "ESPRESSO four-strategy fair "
            "performance comparison"
        )
    )

    parser.add_argument(
        "--input-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help=(
            "Directory containing the 20 experiment "
            "CSV files. Defaults to the script directory."
        ),
    )

    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for generated results.",
    )

    args = parser.parse_args()

    input_dir = args.input_dir.expanduser().resolve()

    output_dir = (
        args.output_dir.expanduser().resolve()
        if args.output_dir
        else input_dir / "espresso_four_strategy_results"
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    print()
    print("=" * 72)
    print("ESPRESSO FOUR-STRATEGY MATCHED ANALYSIS")
    print("=" * 72)

    print(f"Input:  {input_dir}")
    print(f"Output: {output_dir}")

    # --------------------------------------------
    # Verify all 20 CSV files.
    # --------------------------------------------

    input_files = verify_input_files(
        input_dir
    )

    # --------------------------------------------
    # Read experiments.
    # --------------------------------------------

    all_records = []

    print()
    print("INPUT FILES")
    print("-" * 72)

    for scale in SCALES:

        for strategy in STRATEGIES:

            path = input_files[
                (scale, strategy)
            ]

            records = read_experiment_csv(
                path,
                strategy,
                scale,
            )

            all_records.extend(records)

            print(
                f"Scale {scale:4d} | "
                f"{strategy:8s} | "
                f"{len(records):4d} rows"
            )

            print(
                f"    {path}"
            )

    print()
    print(
        f"Total input rows: {len(all_records)}"
    )

    # --------------------------------------------
    # Match configurations.
    # --------------------------------------------

    matched, audit = match_four_strategies(
        all_records
    )

    # --------------------------------------------
    # Always save audit.
    # --------------------------------------------

    write_csv(
        output_dir / "matching_audit.csv",
        audit,
        AUDIT_COLUMNS,
    )

    write_text(
        output_dir / "matching_report.txt",
        build_audit_report(audit),
    )

    print_matching_summary(audit)

    # --------------------------------------------
    # Handle no matches.
    # --------------------------------------------

    if not matched:

        print()
        print("=" * 72)
        print("NO MATCHED CONFIGURATIONS")
        print("=" * 72)

        print()
        print(
            "The matching audit was saved."
        )

        print(
            "Review the exclusion reasons printed above."
        )

        print()
        print(
            f"Audit: {output_dir / 'matching_audit.csv'}"
        )

        print(
            f"Report: {output_dir / 'matching_report.txt'}"
        )

        sys.exit(1)

    # --------------------------------------------
    # Calculate means.
    # --------------------------------------------

    tables = build_mean_tables(
        matched
    )

    # --------------------------------------------
    # Save CSV files.
    # --------------------------------------------

    save_csv_results(
        output_dir,
        matched,
        audit,
        tables,
    )

    # --------------------------------------------
    # Save LaTeX files.
    # --------------------------------------------

    save_latex_results(
        output_dir,
        tables,
    )

    # --------------------------------------------
    # Print output files.
    # --------------------------------------------

    print()
    print("OUTPUT FILES")
    print("-" * 72)

    for path in sorted(
        output_dir.iterdir()
    ):

        if path.is_file():
            print(path.name)

    print()
    print("=" * 72)
    print("ANALYSIS COMPLETED")
    print("=" * 72)

    print()
    print(
        "All four strategies were compared using "
        "the same matched configurations."
    )

    print(
        "Valid no_sources_selected outcomes "
        "were included when results were zero."
    )

    print(
        "Original experiment CSV files "
        "were not modified."
    )

    print()


if __name__ == "__main__":
    main()