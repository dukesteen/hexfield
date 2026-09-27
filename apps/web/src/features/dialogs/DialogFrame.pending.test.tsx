// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ActionPendingContext, DialogFrame } from './DialogFrame';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

test('pending trade dialog keeps its footer outside the scrolling body and blocks controls', () => {
  const cancel = vi.fn<() => void>();
  const page = render(
    <ActionPendingContext.Provider value>
      <DialogFrame
        title="Trade"
        variant="trade"
        onCancel={cancel}
        footer={
          <div className="trade-dialog-footer">
            <button type="button">Send</button>
          </div>
        }
      >
        <button type="button">Change terms</button>
      </DialogFrame>
    </ActionPendingContext.Provider>,
  );
  const dialog = page.getByRole('dialog');
  expect(dialog.getAttribute('aria-busy')).toBe('true');
  expect(page.getByRole('status').textContent).toContain('game:submittingAction');
  const body = dialog.querySelector('.trade-dialog-body');
  const footer = dialog.querySelector('.trade-dialog-footer');
  expect(body?.hasAttribute('inert')).toBe(true);
  expect(footer?.hasAttribute('inert')).toBe(true);
  expect(footer?.parentElement).toBe(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(cancel).not.toHaveBeenCalled();
});
