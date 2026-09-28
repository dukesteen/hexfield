# Final test assertion correction

Production source is unchanged from the immutable review packet. The new conflicting-wire regression initially read `progress.error.code`, although `error` is a string, then expected a string without its phase suffix. Its final assertion is:

```typescript
expect(host.snapshot().phase).toBe('retired');
expect(host.snapshot().error).toBe('online-ceremony-conflict:deck');
```

The full 29-case ceremony run had 28 passes and this assertion failure, with 193.10 seconds of test execution. The corrected two-case run passed in 10.03 seconds. The final source manifest records the corrected test hash separately from the immutable review manifest. No protocol assertion or timeout was weakened.

The reviewer-requested follow-up also observes the wrong sender's outer verification rejection and checks the reconstructed seed-commit bytes against the durable slot before sending the conflict. Both final tests passed in 10.03 seconds.
