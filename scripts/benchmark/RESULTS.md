# Accounting history benchmark

Synthetic catalog, one component. Historical orders were posted with `app.run_accounting_work`. The measured order was the queue head and was timed in a fresh session with `statement_timeout` of 6 seconds. Crossing 2 seconds is recorded and does not fail. No checkpoint was built.

## 35-day

- orders: 3500
- days: 35
- posted historical orders with a posting receipt and movements: 3500
- build elapsed: 01:44:55.534346
- eligible replay rows before the measured call: 3501
- stock_count_anchors: 0
- events plus anchors: 3501
- measured status: processed
- failed: 0
- completion outcome: applied
- receipt_kind: posting
- per-item movement links match negated requirements: true
- split normal and provisional: true
- wall clock seconds: 1.949
- crossed 2s: false
- gate: PASS

## 1-year

- orders in the catalog: 36500
- days: 365
- posted with a posting receipt before the failing call: 3171
- the next call was cancelled with `statement timeout` inside `app.accounting_pending_orders(1001)`, called from `app.run_accounting_work` while counting the remaining queue
- the late order was not inserted and was not measured
- gate: FAIL

Stopped after a failing history. No checkpoint was built.
