import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Splash } from './Splash';

describe('Splash', () => {
  it('shows the BEMRA logo, then hands over after the duration', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<Splash onDone={onDone} durationMs={10_000} />);
    expect(screen.getByLabelText('Loading BEMRA')).toHaveTextContent('BEMRA');
    act(() => vi.advanceTimersByTime(9_999));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
