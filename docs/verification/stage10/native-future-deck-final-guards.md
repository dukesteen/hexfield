# Follow-up guards

After the reviewed source, `#receive` rechecks `this.#disposed || this.snapshot().phase === 'retired'` immediately after its durable lookup/conflict check and before buffering. This prevents repopulating a cleared queue across an asynchronous store wait.

The buffered consume branch in `#exchange` also requires `!this.#restoreExpected`, so a missing completed-restore slot reaches the existing restore failure instead of network repair. No validator, persistence, deadline or retry semantics changed.
