# Accounting history benchmark

Synthetic catalog. Historical orders were posted with `app.run_accounting_work`. The measured order is a new queue head, timed by a top-level statement after the session statement timeout is set to 6 seconds. The soft gate is 2 seconds and the hard gate is 6 seconds. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk.

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- eligible replay rows before the measured call: 3503
- stock_count_anchors: 35
- weekly anchors: 5
- events plus anchors: 3538
- queue depth 1 ms: 0.237
- queue depth 50000 ms: 0.313
- suffix index range: true
- suffix rows: 0
- deficit restore rows: 1
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.081
- crossed 2s: false
- gate: PASS

## 1-year

- orders: 36500
- days: 365
- posted historical orders with a posting receipt and movements: 36500
- eligible replay rows before the measured call: 36503
- stock_count_anchors: 365
- weekly anchors: 52
- events plus anchors: 36868
- queue depth 1 ms: 0.228
- queue depth 50000 ms: 0.19
- suffix index range: true
- suffix rows: 0
- deficit restore rows: 1
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.146
- crossed 2s: false
- gate: PASS

## 2-year

- orders: 73000
- days: 730
- posted historical orders with a posting receipt and movements: 73000
- eligible replay rows before the measured call: 73003
- stock_count_anchors: 730
- weekly anchors: 104
- events plus anchors: 73733
- queue depth 1 ms: 0.7
- queue depth 50000 ms: 7.722
- suffix index range: true
- suffix rows: 0
- deficit restore rows: 1
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.785
- crossed 2s: false
- gate: PASS

The 35-day, 1-year, and 2-year histories passed the gate.
