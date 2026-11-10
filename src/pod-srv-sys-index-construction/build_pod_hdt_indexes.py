#!/usr/bin/env python3

"""
ICDE-Synthea
Fast, Resumable, Source-Aware Genuine HDT Builder

INPUT
-----
Existing pod-level PSO indexes:

    espressoindex/
        webid_<sha256>.nq
        webid_<sha256>.nq.acl
        public-Location.nq
        public-Location.nq.acl

OUTPUT
------
    espressoindex_hdt/
        webid_<sha256>.hdt
        webid_<sha256>.hdt.acl
        public-Location.hdt
        public-Location.hdt.acl

REPRESENTATION
--------------
Each original N-Quad:

    (subject, predicate, object, source)

becomes five RDF triples:

    (predicate, espresso:hasStatement, statementURN)
    (statementURN, rdf:subject, subject)
    (statementURN, rdf:predicate, predicate)
    (statementURN, rdf:object, object)
    (statementURN, espresso:source, source)

The statementURN uses SHA-256 over the N3 representation
of the four original RDF terms separated by null bytes.

VALIDATION
----------
--validation fast

    Default.
    Checks:
      - rdf2hdt exits successfully
      - HDT file exists and is nonempty
      - HDT can be opened
      - HDT reports a plausible triple count
      - Generated ACL is correct

    Does not verify every source mapping.

--validation full

    Performs exact triple-set comparison between
    expected RDF triples and generated HDT triples.

SAFETY
------
- Original RDF files are never modified.
- Original PSO indexes are never modified.
- Original ACL files are never modified.
- Existing completed HDT files are never overwritten.
- Existing completed HDT directories are skipped.
- Newly completed indexes are saved individually.
- Temporary files are cleaned after interruption.
- Incomplete existing output pairs cause an error.
- No automatic deletion of existing HDT indexes.

REQUIREMENTS
------------
    rdflib
    hdt
    rdf2hdt
    Unix sort

RUN
---
    cd ~/ICDE-Synthea/overlay-query-layer
    source .venv-hdt/bin/activate

Fast construction of remaining S1 indexes:

    python build_pod_hdt_indexes.py \
        --server S1 \
        --validation fast

Full validation:

    python build_pod_hdt_indexes.py \
        --server S1 \
        --validation full

All servers:

    python build_pod_hdt_indexes.py \
        --validation fast
"""

import argparse
import filecmp
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import quote

from rdflib import Graph, Namespace, URIRef, BNode
from rdflib.namespace import RDF

from rdflib.plugins.parsers.nquads import NQuadsParser

from rdflib.plugins.parsers.ntriples import (
    ParseError,
    r_wspace,
    r_tail,
)

from rdflib.util import from_n3


# ============================================================
# CONFIGURATION
# ============================================================

BASE = Path.home() / "ICDE-Synthea"

EXPERIMENTS = BASE / "experiments"

SERVER_URLS = {
    "S1": "http://localhost:3001/",
    "S2": "http://localhost:3002/",
    "S3": "http://localhost:3003/",
    "S4": "http://localhost:3004/",
}

INPUT_FOLDER = "espressoindex"

OUTPUT_FOLDER = "espressoindex_hdt"

REPORT_FILE = (
    BASE / "pod_hdt_build_report_fast_resumable.json"
)

ACL = Namespace(
    "http://www.w3.org/ns/auth/acl#"
)

ESP = Namespace(
    "urn:espresso:hdt-index:"
)

STATEMENT_PREFIX = "urn:espresso:statement:"

PROGRESS_EVERY = 100000


# ============================================================
# HELPERS
# ============================================================

def elapsed(start):
    return round(time.perf_counter() - start, 6)


def log(message):
    print(message, flush=True)


def url_for(root, server_url, path):

    relative = path.relative_to(root).as_posix()

    return (
        server_url.rstrip("/")
        + "/"
        + quote(relative, safe="/._-~")
    )


def atomic_write_json(path, data):

    temporary = path.with_name(
        path.name + ".tmp"
    )

    temporary.write_text(
        json.dumps(data, indent=2),
        encoding="utf-8",
    )

    os.replace(temporary, path)


# ============================================================
# POD DISCOVERY
# ============================================================

def pods_for(root):

    patient_root = root / "patient_pods"

    if patient_root.is_dir():

        for pod in sorted(patient_root.iterdir()):

            if (
                pod.is_dir()
                and (pod / INPUT_FOLDER).is_dir()
            ):
                yield pod

    facility_root = root / "facility_pods"

    if facility_root.is_dir():

        for pod in sorted(facility_root.glob("*/*")):

            if (
                pod.is_dir()
                and (pod / INPUT_FOLDER).is_dir()
            ):
                yield pod


# ============================================================
# STREAMING N-QUADS PARSER
# ============================================================

class StreamingNQuadsParser(NQuadsParser):

    """
    Reuses RDFLib's lexical N-Quads parser.

    No Dataset or Graph is constructed for the
    original PSO data.

    This implementation depends on the RDFLib
    parser internals used by the existing builder.
    """

    def __init__(self):

        super().__init__()

        self.skolemize = False

    def parse_one(self, text):

        self.line = text.strip()

        self.eat(r_wspace)

        if (
            not self.line
            or self.line.startswith("#")
        ):
            return None

        subject = self.subject()

        self.eat(r_wspace)

        predicate = self.predicate()

        self.eat(r_wspace)

        obj = self.object()

        self.eat(r_wspace)

        source = (
            self.uriref()
            or self.nodeid()
        )

        self.eat(r_tail)

        if self.line:

            raise ParseError(
                "Unexpected trailing N-Quads content"
            )

        if not isinstance(source, URIRef):

            raise ValueError(
                "Source graph must be an IRI."
            )

        if (
            isinstance(subject, BNode)
            or isinstance(obj, BNode)
        ):

            raise ValueError(
                "Blank nodes are not supported."
            )

        return (
            subject,
            predicate,
            obj,
            source,
        )


def iter_quads(path):

    parser = StreamingNQuadsParser()

    with path.open(
        "r",
        encoding="utf-8",
    ) as handle:

        for line_number, line in enumerate(
            handle,
            start=1,
        ):

            try:

                quad = parser.parse_one(line)

            except Exception as exc:

                raise ValueError(
                    f"N-Quads parsing failed at "
                    f"{path}:{line_number}\n"
                    f"{exc}"
                ) from exc

            if quad is not None:
                yield quad


# ============================================================
# STATEMENT IDENTIFIERS
# ============================================================

def statement_uri(quad):

    """
    SAME statement hash as the previous builder.

    Do not change this representation.
    """

    key = "\x00".join(
        term.n3()
        for term in quad
    ).encode("utf-8")

    digest = hashlib.sha256(
        key
    ).hexdigest()

    return URIRef(
        STATEMENT_PREFIX + digest
    )


# ============================================================
# RDF TRIPLE SERIALIZATION
# ============================================================

def triple_line(subject, predicate, obj):

    return (
        subject.n3()
        + " "
        + predicate.n3()
        + " "
        + obj.n3()
        + " .\n"
    )


def write_triple(
    output,
    subject,
    predicate,
    obj,
):

    output.write(
        triple_line(
            subject,
            predicate,
            obj,
        )
    )


# ============================================================
# ENCODE SOURCE-AWARE RDF TRIPLES
# ============================================================

def encode_nquads_to_nt(
    input_nq,
    output_nt,
):

    start = time.perf_counter()

    quad_count = 0

    with output_nt.open(
        "w",
        encoding="utf-8",
    ) as output:

        for quad in iter_quads(input_nq):

            subject, predicate, obj, source = quad

            statement = statement_uri(quad)

            # Predicate-first routing

            write_triple(
                output,
                predicate,
                ESP.hasStatement,
                statement,
            )

            # Original subject

            write_triple(
                output,
                statement,
                RDF.subject,
                subject,
            )

            # Original predicate

            write_triple(
                output,
                statement,
                RDF.predicate,
                predicate,
            )

            # Original object

            write_triple(
                output,
                statement,
                RDF.object,
                obj,
            )

            # Original source graph

            write_triple(
                output,
                statement,
                ESP.source,
                source,
            )

            quad_count += 1

            if (
                quad_count % PROGRESS_EVERY == 0
            ):

                log(
                    "      Encoded "
                    f"{quad_count:,} N-Quads..."
                )

    return {
        "inputQuads": quad_count,
        "writtenTriples": quad_count * 5,
        "seconds": elapsed(start),
    }


# ============================================================
# ACL GENERATION
# ============================================================

def make_acl(
    old_acl,
    old_url,
    new_url,
):

    """
    Preserve explicit Read authorizations.

    This does not evaluate inherited ACLs,
    acl:default, or ACP policies.
    """

    source_graph = Graph()

    source_graph.parse(
        str(old_acl),
        format="turtle",
        publicID=old_url + ".acl",
    )

    destination_graph = Graph()

    authorizations = sorted(
        set(
            source_graph.subjects(
                RDF.type,
                ACL.Authorization,
            )
        ),
        key=str,
    )

    found = 0

    for authorization in authorizations:

        targets = set(
            source_graph.objects(
                authorization,
                ACL.accessTo,
            )
        )

        if URIRef(old_url) not in targets:
            continue

        modes = set(
            source_graph.objects(
                authorization,
                ACL.mode,
            )
        )

        if ACL.Read not in modes:
            continue

        agents = list(
            source_graph.objects(
                authorization,
                ACL.agent,
            )
        )

        agent_classes = list(
            source_graph.objects(
                authorization,
                ACL.agentClass,
            )
        )

        agent_groups = list(
            source_graph.objects(
                authorization,
                ACL.agentGroup,
            )
        )

        origins = list(
            source_graph.objects(
                authorization,
                ACL.origin,
            )
        )

        if not (
            agents
            or agent_classes
            or agent_groups
        ):

            raise ValueError(
                "Unrecognized ACL principal: "
                f"{authorization}"
            )

        new_authorization = URIRef(
            new_url
            + ".acl#read-"
            + str(found)
        )

        destination_graph.add(
            (
                new_authorization,
                RDF.type,
                ACL.Authorization,
            )
        )

        destination_graph.add(
            (
                new_authorization,
                ACL.accessTo,
                URIRef(new_url),
            )
        )

        destination_graph.add(
            (
                new_authorization,
                ACL.mode,
                ACL.Read,
            )
        )

        for field, values in (
            (ACL.agent, agents),
            (ACL.agentClass, agent_classes),
            (ACL.agentGroup, agent_groups),
            (ACL.origin, origins),
        ):

            for value in values:

                destination_graph.add(
                    (
                        new_authorization,
                        field,
                        value,
                    )
                )

        found += 1

    if found == 0:

        raise ValueError(
            "No explicit Read authorization "
            f"for {old_url}"
        )

    return destination_graph


def verify_acl(
    acl_file,
    expected_graph,
    new_url,
):

    check_graph = Graph()

    check_graph.parse(
        str(acl_file),
        format="turtle",
        publicID=new_url + ".acl",
    )

    if set(check_graph) != set(expected_graph):

        raise RuntimeError(
            "Generated ACL verification failed: "
            f"{acl_file}"
        )


# ============================================================
# GENUINE HDT CONSTRUCTION
# ============================================================

def run_converter(
    nt_file,
    hdt_file,
    executable,
):

    start = time.perf_counter()

    command = [
        executable,
        "-f",
        "ntriples",
        str(nt_file),
        str(hdt_file),
    ]

    result = subprocess.run(
        command,
        check=False,
    )

    if result.returncode != 0:

        raise RuntimeError(
            "rdf2hdt failed with exit code "
            f"{result.returncode}\n"
            f"Command: {command}"
        )

    if (
        not hdt_file.is_file()
        or hdt_file.stat().st_size == 0
    ):

        raise RuntimeError(
            "Converter did not produce "
            f"a nonempty HDT file: {hdt_file}"
        )

    return elapsed(start)


# ============================================================
# FAST HDT VALIDATION
# ============================================================

def validate_hdt_fast(
    hdt_file,
    encoded_triples,
):

    """
    Lightweight structural validation.

    Does not scan every triple.

    The HDT reader's reported count is checked
    against the maximum number of encoded triples.

    This does not prove complete content equality.
    """

    from hdt import HDTDocument

    start = time.perf_counter()

    log(
        "    [VALIDATE FAST] Opening HDT..."
    )

    document = HDTDocument(
        str(hdt_file)
    )

    triples = None

    try:

        triples, reported_count = (
            document.search_triples(
                "",
                "",
                "",
            )
        )

        if reported_count < 0:

            raise RuntimeError(
                "HDT reported a negative triple count."
            )

        if reported_count > encoded_triples:

            raise RuntimeError(
                "HDT reports more triples than "
                "were written by the encoder.\n"
                f"Encoded: {encoded_triples}\n"
                f"HDT: {reported_count}"
            )

        if (
            encoded_triples > 0
            and reported_count == 0
        ):

            raise RuntimeError(
                "Nonempty input produced an "
                "HDT with zero triples."
            )

        # Read one triple to verify that the
        # reader can access the HDT data.

        if reported_count > 0:

            first = next(iter(triples), None)

            if first is None:

                raise RuntimeError(
                    "HDT reports triples but "
                    "none could be read."
                )

    finally:

        del triples
        del document

    return {
        "hdtTriples": reported_count,
        "validationMode": "fast",
        "exactContentValidated": False,
        "seconds": elapsed(start),
    }


# ============================================================
# HDT TERM NORMALIZATION
# ============================================================

def hdt_term(value):

    if value.startswith("_:"):

        raise ValueError(
            "Unexpected blank node in HDT."
        )

    if value.startswith('"'):

        term = from_n3(value)

        if term is None:

            raise ValueError(
                "Cannot parse HDT literal: "
                f"{value}"
            )

        return term

    if (
        value.startswith("<")
        and value.endswith(">")
    ):

        return from_n3(value)

    return URIRef(value)


# ============================================================
# EXTERNAL SORT
# ============================================================

def sort_unique(
    input_file,
    output_file,
    working_directory,
):

    environment = os.environ.copy()

    environment["LC_ALL"] = "C"

    command = [
        "sort",
        "-u",
        "-T",
        str(working_directory),
        "-o",
        str(output_file),
        str(input_file),
    ]

    subprocess.run(
        command,
        check=True,
        env=environment,
    )


def count_lines(path):

    count = 0

    with path.open("rb") as handle:

        for _ in handle:
            count += 1

    return count


# ============================================================
# FULL EXACT VALIDATION
# ============================================================

def validate_hdt_full(
    hdt_file,
    expected_nt,
    working_directory,
):

    """
    Compare complete expected and actual
    RDF triple sets.

    Duplicate triples are deduplicated
    before comparison.

    This is expensive for large indexes.
    """

    from hdt import HDTDocument

    start = time.perf_counter()

    actual_nt = (
        working_directory / "actual_hdt.nt"
    )

    expected_sorted = (
        working_directory / "expected_sorted.nt"
    )

    actual_sorted = (
        working_directory / "actual_sorted.nt"
    )

    log(
        "    [VALIDATE FULL] Reading HDT triples..."
    )

    document = HDTDocument(
        str(hdt_file)
    )

    triples, reported_count = (
        document.search_triples(
            "",
            "",
            "",
        )
    )

    read_count = 0

    try:

        with actual_nt.open(
            "w",
            encoding="utf-8",
        ) as output:

            for s, p, o in triples:

                write_triple(
                    output,
                    hdt_term(s),
                    hdt_term(p),
                    hdt_term(o),
                )

                read_count += 1

                if (
                    read_count % PROGRESS_EVERY == 0
                ):

                    log(
                        "      Read "
                        f"{read_count:,} HDT triples..."
                    )

    finally:

        del triples
        del document

    if read_count != reported_count:

        raise RuntimeError(
            "HDT reader count mismatch.\n"
            f"Reported: {reported_count}\n"
            f"Read: {read_count}"
        )

    log(
        "    [VALIDATE FULL] Sorting expected..."
    )

    sort_unique(
        expected_nt,
        expected_sorted,
        working_directory,
    )

    log(
        "    [VALIDATE FULL] Sorting actual..."
    )

    sort_unique(
        actual_nt,
        actual_sorted,
        working_directory,
    )

    actual_nt.unlink(
        missing_ok=True
    )

    expected_unique = count_lines(
        expected_sorted
    )

    actual_unique = count_lines(
        actual_sorted
    )

    if expected_unique != actual_unique:

        raise RuntimeError(
            "HDT unique triple count mismatch.\n"
            f"Expected: {expected_unique}\n"
            f"Actual: {actual_unique}"
        )

    if not filecmp.cmp(
        expected_sorted,
        actual_sorted,
        shallow=False,
    ):

        first_difference = None

        with expected_sorted.open(
            "r",
            encoding="utf-8",
        ) as expected_handle, actual_sorted.open(
            "r",
            encoding="utf-8",
        ) as actual_handle:

            for line_number, (
                expected_line,
                actual_line,
            ) in enumerate(
                itertools.zip_longest(
                    expected_handle,
                    actual_handle,
                ),
                start=1,
            ):

                if expected_line != actual_line:

                    first_difference = (
                        line_number,
                        expected_line,
                        actual_line,
                    )

                    break

        raise RuntimeError(
            "HDT exact validation failed.\n"
            f"First difference: {first_difference}"
        )

    expected_sorted.unlink(
        missing_ok=True
    )

    actual_sorted.unlink(
        missing_ok=True
    )

    return {
        "hdtTriples": actual_unique,
        "validationMode": "full",
        "exactContentValidated": True,
        "seconds": elapsed(start),
    }


# ============================================================
# EXISTING OUTPUT SAFETY
# ============================================================

def output_paths(
    destination,
    index,
):

    hdt = destination / (
        index.stem + ".hdt"
    )

    acl = Path(
        str(hdt) + ".acl"
    )

    return hdt, acl


def completed_index_exists(
    destination,
    index,
):

    """
    Existing complete output pairs are skipped.

    An incomplete pair causes an error instead
    of being overwritten or silently repaired.
    """

    hdt, acl = output_paths(
        destination,
        index,
    )

    hdt_exists = hdt.exists()

    acl_exists = acl.exists()

    if not hdt_exists and not acl_exists:
        return False

    if (
        hdt.is_file()
        and hdt.stat().st_size > 0
        and acl.is_file()
        and acl.stat().st_size > 0
    ):

        return True

    raise RuntimeError(
        "Existing HDT output is incomplete.\n"
        "Refusing to overwrite:\n"
        f"{hdt}\n"
        f"{acl}"
    )


def inspect_pod(
    destination,
    indexes,
):

    completed = []

    remaining = []

    for index in indexes:

        if completed_index_exists(
            destination,
            index,
        ):

            completed.append(index)

        else:

            remaining.append(index)

    return completed, remaining


# ============================================================
# SAFE INDIVIDUAL-INDEX PUBLICATION
# ============================================================

def publish_index(
    temporary_hdt,
    temporary_acl,
    final_hdt,
    final_acl,
):

    """
    Publish without replacing existing files.

    os.link creates the destination only if it
    does not already exist.

    Both files are validated before publication.

    If publishing the second file fails, the
    newly published first file is rolled back.

    This is not a fully atomic two-file
    transaction; an abrupt system crash between
    links may leave an incomplete pair, which
    resume will detect and refuse to overwrite.
    """

    if (
        final_hdt.exists()
        or final_acl.exists()
    ):

        raise FileExistsError(
            "Refusing to overwrite existing output:\n"
            f"{final_hdt}\n"
            f"{final_acl}"
        )

    created_hdt = False

    created_acl = False

    try:

        os.link(
            temporary_hdt,
            final_hdt,
        )

        created_hdt = True

        os.link(
            temporary_acl,
            final_acl,
        )

        created_acl = True

    except BaseException:

        if created_acl:
            final_acl.unlink(
                missing_ok=True
            )

        if created_hdt:
            final_hdt.unlink(
                missing_ok=True
            )

        raise


# ============================================================
# BUILD ONE INDEX
# ============================================================

def build_one(
    index,
    destination,
    root,
    server_url,
    converter,
    validation_mode,
):

    start = time.perf_counter()

    final_hdt, final_acl = output_paths(
        destination,
        index,
    )

    if (
        final_hdt.exists()
        or final_acl.exists()
    ):

        raise FileExistsError(
            "Output already exists; refusing "
            f"to overwrite: {final_hdt}"
        )

    original_acl = Path(
        str(index) + ".acl"
    )

    if not original_acl.is_file():

        raise FileNotFoundError(
            original_acl
        )

    original_url = url_for(
        root,
        server_url,
        index,
    )

    new_url = url_for(
        root,
        server_url,
        final_hdt,
    )

    # Prepare the ACL before spending time
    # constructing the HDT.

    acl_graph = make_acl(
        original_acl,
        original_url,
        new_url,
    )

    # Each index gets its own staging directory.
    # This allows completed indexes in the same
    # pod to survive later failures.

    with tempfile.TemporaryDirectory(
        prefix=".espresso-hdt-staging-",
        dir=destination,
    ) as temporary_directory:

        staged = Path(
            temporary_directory
        )

        temporary_nt = (
            staged / (index.stem + ".nt")
        )

        temporary_hdt = (
            staged / (index.stem + ".hdt")
        )

        temporary_acl = Path(
            str(temporary_hdt) + ".acl"
        )

        # ----------------------------------------
        # ENCODE
        # ----------------------------------------

        log(
            "    [ENCODE] Reading original PSO index..."
        )

        encoding = encode_nquads_to_nt(
            index,
            temporary_nt,
        )

        log(
            "    [ENCODE] "
            f"{encoding['inputQuads']:,} quads "
            f"in {encoding['seconds']} s"
        )

        # ----------------------------------------
        # CONSTRUCT HDT
        # ----------------------------------------

        log(
            "    [HDT] Starting rdf2hdt..."
        )

        conversion_seconds = run_converter(
            temporary_nt,
            temporary_hdt,
            converter,
        )

        log(
            "    [HDT] Finished in "
            f"{conversion_seconds} s"
        )

        # ----------------------------------------
        # VALIDATE
        # ----------------------------------------

        if validation_mode == "full":

            validation = validate_hdt_full(
                temporary_hdt,
                temporary_nt,
                staged,
            )

        else:

            validation = validate_hdt_fast(
                temporary_hdt,
                encoding["writtenTriples"],
            )

        log(
            "    [VALIDATE] "
            f"Mode={validation_mode} | "
            f"HDT triples="
            f"{validation['hdtTriples']:,} | "
            f"Time={validation['seconds']} s"
        )

        # The temporary N-Triples file is no
        # longer needed.

        temporary_nt.unlink(
            missing_ok=True
        )

        # ----------------------------------------
        # ACL
        # ----------------------------------------

        acl_graph.serialize(
            destination=str(temporary_acl),
            format="turtle",
        )

        verify_acl(
            temporary_acl,
            acl_graph,
            new_url,
        )

        # ----------------------------------------
        # PREPARE REPORT ENTRY
        # ----------------------------------------

        entry = {
            "original": index.name,
            "hdt": final_hdt.name,
            "quads": encoding["inputQuads"],
            "encodedTriples": encoding["writtenTriples"],
            "hdtTriples": validation["hdtTriples"],
            "originalBytes": index.stat().st_size,
            "hdtBytes": temporary_hdt.stat().st_size,
            "encodingSeconds": encoding["seconds"],
            "conversionSeconds": conversion_seconds,
            "validationSeconds": validation["seconds"],
            "validationMode": validation_mode,
            "exactContentValidated": validation[
                "exactContentValidated"
            ],
            "constructionSeconds": elapsed(start),
        }

        # ----------------------------------------
        # PUBLISH
        # ----------------------------------------

        publish_index(
            temporary_hdt,
            temporary_acl,
            final_hdt,
            final_acl,
        )

        return entry


# ============================================================
# MAIN
# ============================================================

def main():

    parser = argparse.ArgumentParser(
        description=__doc__,
    )

    parser.add_argument(
        "--server",
        choices=list(SERVER_URLS),
        default=None,
        help="Process one server only.",
    )

    parser.add_argument(
        "--validation",
        choices=["fast", "full"],
        default="fast",
        help=(
            "fast: structural checks; "
            "full: exact triple-set comparison."
        ),
    )

    parser.add_argument(
        "--rdf2hdt",
        default=str(
            BASE
            / "hdt-install"
            / "bin"
            / "rdf2hdt"
        ),
        help="Path to genuine rdf2hdt converter.",
    )

    parser.add_argument(
        "--max-new-pods",
        type=int,
        default=None,
        help=(
            "Optional limit on pods containing "
            "new work."
        ),
    )

    args = parser.parse_args()

    if not shutil.which(args.rdf2hdt):

        parser.error(
            "Cannot find rdf2hdt: "
            f"{args.rdf2hdt}"
        )

    if (
        args.validation == "full"
        and not shutil.which("sort")
    ):

        parser.error(
            "Full validation requires Unix sort."
        )

    try:

        from hdt import HDTDocument

    except ImportError:

        parser.error(
            "Python HDT reader is not installed."
        )

    if (
        args.max_new_pods is not None
        and args.max_new_pods < 1
    ):

        parser.error(
            "--max-new-pods must be positive."
        )

    servers = (
        [args.server]
        if args.server
        else list(SERVER_URLS)
    )

    # ----------------------------------------
    # DISCOVERY
    # ----------------------------------------

    plan = []

    completed_pods = 0

    completed_indexes = 0

    remaining_indexes = 0

    for server_name in servers:

        server_root = (
            EXPERIMENTS / server_name
        )

        if not server_root.is_dir():

            raise FileNotFoundError(
                server_root
            )

        for pod in pods_for(server_root):

            indexes = sorted(
                (pod / INPUT_FOLDER).glob("*.nq")
            )

            if not indexes:
                continue

            destination = (
                pod / OUTPUT_FOLDER
            )

            completed, remaining = inspect_pod(
                destination,
                indexes,
            )

            completed_indexes += len(completed)

            if not remaining:

                completed_pods += 1

                log(
                    "[SKIP completed] "
                    f"{server_name} {pod.name}"
                )

                continue

            for index in remaining:

                original_acl = Path(
                    str(index) + ".acl"
                )

                if not original_acl.is_file():

                    raise FileNotFoundError(
                        original_acl
                    )

            remaining_indexes += len(remaining)

            plan.append(
                (
                    server_name,
                    server_root,
                    pod,
                    destination,
                    remaining,
                )
            )

    total_remaining_pods = len(plan)

    total_remaining_indexes = remaining_indexes

    if args.max_new_pods is not None:

        plan = plan[
            :args.max_new_pods
        ]

    selected_indexes = sum(
        len(item[4])
        for item in plan
    )

    log("")
    log("=" * 70)
    log("ESPRESSO FAST RESUMABLE HDT BUILD PLAN")
    log("=" * 70)

    log(
        f"Validation mode: {args.validation}"
    )

    log(
        f"Completed pods skipped: {completed_pods}"
    )

    log(
        f"Previously completed indexes: "
        f"{completed_indexes}"
    )

    log(
        f"Pods with remaining work: "
        f"{total_remaining_pods}"
    )

    log(
        f"Remaining indexes discovered: "
        f"{total_remaining_indexes}"
    )

    log(
        f"Indexes selected for this run: "
        f"{selected_indexes}"
    )

    log("=" * 70)

    # ----------------------------------------
    # REPORT
    # ----------------------------------------

    report = {
        "representation": (
            "Genuine source-aware HDT"
        ),
        "encoding": (
            "Five RDF triples per input N-Quad"
        ),
        "validationMode": args.validation,
        "servers": servers,
        "previouslyCompletedPods": completed_pods,
        "previouslyCompletedIndexes": completed_indexes,
        "remainingIndexesAtStart": (
            total_remaining_indexes
        ),
        "selectedIndexes": selected_indexes,
        "startedAtUnix": time.time(),
        "completedNewIndexes": 0,
        "pods": [],
    }

    # ----------------------------------------
    # BUILD
    # ----------------------------------------

    for pod_number, (
        server_name,
        server_root,
        pod,
        destination,
        remaining,
    ) in enumerate(
        plan,
        start=1,
    ):

        log("")
        log(
            f"[POD {pod_number}/{len(plan)}] "
            f"{server_name} {pod.name}"
        )

        # Create the output directory only for
        # pods that still need conversion.
        #
        # Existing completed indexes are
        # preserved inside it.

        destination.mkdir(
            parents=True,
            exist_ok=True,
        )

        pod_report = {
            "server": server_name,
            "pod": str(pod),
            "indexes": [],
        }

        report["pods"].append(
            pod_report
        )

        for index_number, index in enumerate(
            remaining,
            start=1,
        ):

            # Recheck before construction.

            if completed_index_exists(
                destination,
                index,
            ):

                log(
                    "  [SKIP existing] "
                    f"{index.name}"
                )

                continue

            log(
                f"  [INDEX {index_number}/"
                f"{len(remaining)}] "
                f"{index.name}"
            )

            entry = build_one(
                index=index,
                destination=destination,
                root=server_root,
                server_url=SERVER_URLS[
                    server_name
                ],
                converter=args.rdf2hdt,
                validation_mode=args.validation,
            )

            pod_report["indexes"].append(
                entry
            )

            report["completedNewIndexes"] += 1

            # Save progress after every
            # completed index.

            atomic_write_json(
                REPORT_FILE,
                report,
            )

            log(
                "  [INDEX COMPLETE] "
                f"{index.name}"
            )

            log(
                "    Encode: "
                f"{entry['encodingSeconds']} s"
            )

            log(
                "    HDT: "
                f"{entry['conversionSeconds']} s"
            )

            log(
                "    Validate: "
                f"{entry['validationSeconds']} s"
            )

        log(
            "[POD COMPLETE] "
            f"{server_name} {pod.name}"
        )

    # ----------------------------------------
    # FINAL REPORT
    # ----------------------------------------

    report["finishedAtUnix"] = time.time()

    report["newIndexCount"] = (
        report["completedNewIndexes"]
    )

    atomic_write_json(
        REPORT_FILE,
        report,
    )

    log("")
    log("=" * 70)
    log("GENUINE HDT BUILD COMPLETE")
    log("=" * 70)

    log(
        "Previously completed indexes: "
        f"{completed_indexes}"
    )

    log(
        "Newly completed indexes: "
        f"{report['completedNewIndexes']}"
    )

    log(
        f"Validation mode: {args.validation}"
    )

    log(
        f"Report: {REPORT_FILE}"
    )

    log("")
    log("Original RDF files: UNCHANGED")
    log("Original RDF ACLs: UNCHANGED")
    log("Original PSO indexes: UNCHANGED")
    log("Existing HDT indexes: PRESERVED")
    log("New HDT indexes: CREATED")

    if args.validation == "full":

        log(
            "New HDT indexes: "
            "EXACT CONTENT VALIDATED"
        )

    else:

        log(
            "New HDT indexes: "
            "STRUCTURALLY VALIDATED"
        )

        log(
            "NOTE: Fast validation does not "
            "prove complete triple-set equality."
        )

    log("")
    log(
        "Server-level HDT indexes, overlay-level "
        "HDT indexes, and query-engine migration "
        "remain separate tasks."
    )


if __name__ == "__main__":
    main()