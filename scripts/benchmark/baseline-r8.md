# Round 8 Baseline Benchmark (Pinned Round-7 Commit)

Baseline measurement recorded before any Round 8 replay code changes, from a single clean invocation on a fresh local database built at the exact Round 7 tree.

## Run metadata

- **Baseline SHA**: `51199f23480999ffba932fc3e91ce532199b016f`
- **Invocation**: `node scripts/benchmark/accounting-history.mjs` (fresh DB, no pre-existing benchmark results, no `--resume`, no `--skip-build`, no start-history argument, no `--sort-only`)
- **Cairo anchor**: `2026-11-24 22:00:00+00`
- **Completed**: `2026-11-25 20:15` (`Africa/Cairo`)
- **Exit code**: `0`
- **Histories reached**: all 6 (`35-day sorts`, `1-year sorts`, `2-year sorts`, `35-day`, `1-year`, `2-year`)

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- eligible replay rows before the measured call: 3503
- stock_count_anchors: 35
- weekly anchors: 5
- events plus anchors: 3538
- queue depth 1 ms: 0.750
- queue depth 50000 ms: 0.557
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 16.675
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 3
- fresh pass: true
- selective restore seconds: 0.011
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 9
- selective resumed: true
- large-share restore seconds: 0.016
- large-share restore crossed 2s: false
- large-share prefix rows: 0
- large-share deficit rows: 201
- large-share buffers: 426
- large-share resumed: true
- large-share table rows: 402
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.070
- crossed 2s: false
- aged cover seconds: 0.024
- aged cover crossed 2s: false
- aged prefix rows: 0
- aged deficit rows: 1
- aged buffers: 11
- aged resumed: true
- aged deficit covered: true
- gate: PASS

## 1-year

- orders: 36500
- days: 365
- posted historical orders with a posting receipt and movements: 36500
- eligible replay rows before the measured call: 36503
- stock_count_anchors: 365
- weekly anchors: 52
- events plus anchors: 36868
- queue depth 1 ms: 6.308
- queue depth 50000 ms: 5.825
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 43.889
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 4
- fresh pass: true
- selective restore seconds: 0.011
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 10
- selective resumed: true
- large-share restore seconds: 0.022
- large-share restore crossed 2s: false
- large-share prefix rows: 0
- large-share deficit rows: 404
- large-share buffers: 840
- large-share resumed: true
- large-share table rows: 808
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.141
- crossed 2s: false
- aged cover seconds: 0.032
- aged cover crossed 2s: false
- aged prefix rows: 0
- aged deficit rows: 1
- aged buffers: 11
- aged resumed: true
- aged deficit covered: true
- gate: PASS

## 2-year

- orders: 73000
- days: 730
- posted historical orders with a posting receipt and movements: 73000
- eligible replay rows before the measured call: 73003
- stock_count_anchors: 730
- weekly anchors: 104
- events plus anchors: 73733
- queue depth 1 ms: 12.226
- queue depth 50000 ms: 11.576
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 128.379
- prefix rows: 0
- resumed from checkpoint: true
- shared hit+read limit: 5000
- fresh buffers: 4
- fresh pass: true
- selective restore seconds: 0.011
- selective restore crossed 2s: false
- selective prefix rows: 0
- selective deficit rows: 1
- selective buffers: 10
- selective resumed: true
- large-share restore seconds: 0.030
- large-share restore crossed 2s: false
- large-share prefix rows: 0
- large-share deficit rows: 810
- large-share buffers: 2082
- large-share resumed: true
- large-share table rows: 1620
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.313
- crossed 2s: false
- aged cover seconds: 0.092
- aged cover crossed 2s: false
- aged prefix rows: 0
- aged deficit rows: 1
- aged buffers: 9
- aged resumed: true
- aged deficit covered: true
- gate: PASS

## Sort-traversal baseline (same invocation)

### 35-day sorts

- days: 35
- frozen sorts: 35
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- checkpoint ID: 4
- checkpoint cut: `2026-11-24T10:00:00+00:00`
- session warmup: rolled-back `record_purchase` (warmed)
- shared hit+read limit: 5000
- warmed rpc buffers: 1408
- warmed rpc seconds: 0.015
- crossed 2s: false
- gate: PASS

### 1-year sorts

- days: 365
- frozen sorts: 365
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- checkpoint ID: 10
- checkpoint cut: `2026-11-24T10:00:00+00:00`
- session warmup: rolled-back `record_purchase` (warmed)
- shared hit+read limit: 5000
- warmed rpc buffers: 1256
- warmed rpc seconds: 0.015
- crossed 2s: false
- gate: PASS

### 2-year sorts

- days: 730
- frozen sorts: 730
- suffix movements: 1
- open deficits: 3
- resumed from checkpoint: true
- checkpoint ID: 16
- checkpoint cut: `2026-11-24T10:00:00+00:00`
- session warmup: rolled-back `record_purchase` (warmed)
- shared hit+read limit: 5000
- warmed rpc buffers: 1292
- warmed rpc seconds: 0.016
- crossed 2s: false
- gate: PASS
