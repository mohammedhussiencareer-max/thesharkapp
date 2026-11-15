# Accounting history benchmark

Synthetic catalog. Each history ends yesterday: past orders are frozen activation inputs and post on their own day. The measured order is a new order today, timed by a top-level statement after the session statement timeout is set to 6 seconds. A separate purchase today covers a deficit from 40 days ago and is timed the same way. The soft gate is 2 seconds and the hard gate is 6 seconds. Both reads must index-scan both suffix arms of stock_movements, and the deficit restore must be an index scan of replay_checkpoint_deficits. The fresh order also requires that restore to load at least 1000 deficits. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk.

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- eligible replay rows before the measured call: 3503
- stock_count_anchors: 35
- weekly anchors: 5
- events plus anchors: 3538
- queue depth 1 ms: 0.341
- queue depth 50000 ms: 0.856
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 21.109
- deficit restore rows: 1001
- deficit restore index: true
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.077
- crossed 2s: false
- aged cover seconds: 0.069
- aged cover crossed 2s: false
- aged suffix index: true
- aged deficit restore index: true
- aged deficit rows: 1
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
- queue depth 1 ms: 0.266
- queue depth 50000 ms: 0.616
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 92.759
- deficit restore rows: 1001
- deficit restore index: true
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.24
- crossed 2s: false
- aged cover seconds: 0.141
- aged cover crossed 2s: false
- aged suffix index: true
- aged deficit restore index: true
- aged deficit rows: 1
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
- queue depth 1 ms: 0.583
- queue depth 50000 ms: 0.342
- suffix index range: true
- suffix rows: 4
- time arm rows: 2
- id arm rows: 2
- time arm index: true
- id arm index: true
- confirming replay ms: 169.82
- deficit restore rows: 1001
- deficit restore index: true
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 0.463
- crossed 2s: false
- aged cover seconds: 0.186
- aged cover crossed 2s: false
- aged suffix index: true
- aged deficit restore index: true
- aged deficit rows: 1
- aged deficit covered: true
- gate: PASS

The 35-day, 1-year, and 2-year histories passed the gate.
