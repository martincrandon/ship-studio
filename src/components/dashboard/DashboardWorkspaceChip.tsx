import { SwitchWorkspaceIcon } from '@/components/icons';

interface DashboardWorkspaceChipProps {
  account: { name: string; color: string };
  onSwitch: () => void;
}

export function DashboardWorkspaceChip({ account, onSwitch }: DashboardWorkspaceChipProps) {
  return (
    <button
      type="button"
      className="dashboard-workspace-chip text-style-control-semibold"
      onClick={onSwitch}
      title="Switch workspace"
    >
      <span className="dashboard-workspace-chip-dot" style={{ backgroundColor: account.color }} />
      <span className="dashboard-workspace-chip-name">{account.name}</span>
      <SwitchWorkspaceIcon size={12} />
    </button>
  );
}
