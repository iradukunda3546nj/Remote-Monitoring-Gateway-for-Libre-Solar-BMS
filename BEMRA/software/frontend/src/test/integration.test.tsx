/** The single-page dashboard rendered against real backend responses (fetch mocked). */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { installMockApi } from './mockApi';
import { createQueryClient } from '../App';
import { Dashboard } from '../dashboard/Dashboard';

// jsdom has no canvas: replace only the ECharts canvas binding.
vi.mock('../components/charts/EChart', () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

function renderDashboard(device = 'bms-001') {
  window.history.replaceState(null, '', `/?device=${device}`);
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return render(
    <QueryClientProvider client={client}>
      <Dashboard />
    </QueryClientProvider>,
  );
}
const summary = () => screen.getByLabelText('Telemetry summary');

describe('dashboard data binding', () => {
  it('shows the measurements of the selected device', async () => {
    installMockApi({ fresh: true });
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('soc-readout')).toHaveTextContent('78.5%'));
    expect(summary()).toHaveTextContent('13.24');
    expect(summary()).toHaveTextContent('−2.15');
    expect(summary()).toHaveTextContent('NORMAL');
    expect(screen.getByTestId('flow-caption')).toHaveTextContent('Discharging');
    expect(screen.getByText('4S · Δ 16.0 mV')).toBeInTheDocument();
    expect(await screen.findByText('API connected')).toBeInTheDocument();
  });

  it('updates battery and direction when a new measurement arrives', async () => {
    installMockApi({ fresh: true });
    const { unmount } = renderDashboard();
    await waitFor(() => expect(screen.getByTestId('soc-readout')).toHaveTextContent('78.5%'));
    unmount();
    installMockApi({ fresh: true, latest001: { rSOC_pct: 60, rPackCurrent_A: 2.5 } });
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('soc-readout')).toHaveTextContent('60.0%'));
    expect(screen.getByTestId('soc-fill')).toHaveStyle({ transform: 'scaleX(0.6)' });
    expect(screen.getByTestId('flow-caption')).toHaveTextContent('Charging');
  });

  it('marks stale data and stops presenting it as live', async () => {
    installMockApi({ fresh: false });
    renderDashboard();
    await waitFor(() => expect(screen.getByLabelText('Battery')).toHaveTextContent('STALE'));
    expect(screen.getByTestId('flow-caption')).toHaveTextContent('Not live');
  });

  it('shows the API as unavailable when the backend is down', async () => {
    installMockApi({ down: true });
    renderDashboard();
    expect(await screen.findByText('API unavailable')).toBeInTheDocument();
    expect((await screen.findAllByText(/Backend unreachable/)).length).toBeGreaterThan(0);
  });
});

describe('device isolation', () => {
  it('selecting another device shows only that device', async () => {
    installMockApi({ fresh: true, withSecondDevice: true });
    renderDashboard('bms-001');
    await waitFor(() => expect(screen.getByTestId('soc-readout')).toHaveTextContent('78.5%'));
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText('Select device'), 'bms-002');
    await waitFor(() => expect(screen.getByTestId('soc-readout')).toHaveTextContent('41.0%'));
    expect(screen.getByTestId('status-device')).toHaveTextContent('bms-002');
    expect(within(summary()).queryByText('78.5')).not.toBeInTheDocument();
    expect(screen.getByText(/^8S/)).toBeInTheDocument();
    expect(screen.getByTestId('flow-caption')).toHaveTextContent('Charging');
    expect(window.location.search).toBe('?device=bms-002');
  });
});
