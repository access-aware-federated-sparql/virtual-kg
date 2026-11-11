
# Access-Aware Federated Query Processing over Solid Pods

This repository contains the implementation and experimental artefacts for efficient federated SPARQL querying over decentralised, access-controlled RDF resources hosted in Solid Pods.

The evaluation compares four query-processing approaches:

- **Baseline:** Federated query execution without index-based source selection.
- **Case 1:** Access-aware source selection with index-based execution.
- **Case 2:** Index-assisted source selection with RDF execution.
- **Case 3:** HDT-based query execution.

## Repository structure

- `figures/` contains experimental figures and plots.
- `dataset/` contains illustrative sample data.
- `deployment/` contains deployment resources.
- `queries/` contains the SPARQL benchmark workload.
- `results/` contains experimental measurements and benchmark selections.
- `src/` contains scripts for data processing, indexing and query execution.

## Sample data

The `dataset/Sample-dataset/` directory contains an illustrative subset of the decentralised healthcare dataset. The complete experimental deployment is not included.

## Experimental evaluation

The experiments investigate query latency, HTTP request overhead, scalability, incremental index maintenance and storage efficiency across decentralised Solid Pods.

Results for the baseline and three evaluated cases are provided in `results/`.

## Running

The experiment scripts are available in `src/`. Execution requires the appropriate dependencies, configuration and deployed Solid environment.

