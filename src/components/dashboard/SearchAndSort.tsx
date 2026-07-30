/**
 * SearchAndSort — section header with title, sort dropdown, and new-folder
 * button. The search input itself lives in DashboardHeader; this component
 * handles the sort/section controls row beneath it.
 *
 * @module components/SearchAndSort
 */

import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { ChevronIcon, CheckIcon, FolderPlusIcon, GridIcon, ListIcon } from '../icons';
import { trackEvent } from '../../lib/analytics';
import type { ProjectViewMode } from './ProjectGridView';

/** Dashboard project sort keys. */
export type SortOption = 'last_opened' | 'name';

const SORT_LABELS: Record<SortOption, string> = {
  last_opened: 'Last opened',
  name: 'Name',
};

/** Props for the dashboard section controls row. */
export interface SearchAndSortProps {
  title: string;
  totalCount: number;
  sortBy: SortOption;
  viewMode: ProjectViewMode;
  onSortChange: (option: SortOption) => void;
  onViewModeChange: (mode: ProjectViewMode) => void;
  onNewFolder: () => void;
  /** Optional element rendered just after the title (e.g. a workspace chip). */
  titleAccessory?: React.ReactNode;
}

/**
 * Renders dashboard sort, view-mode, and folder creation controls.
 * @param props - Section label, active controls, and action callbacks.
 */
export function SearchAndSort({
  title,
  totalCount,
  sortBy,
  viewMode,
  onSortChange,
  onViewModeChange,
  onNewFolder,
  titleAccessory,
}: SearchAndSortProps) {
  return (
    <div className="dashboard-section-header">
      <div className="dashboard-section-heading">
        <span className="dashboard-section-title">
          {title} {totalCount > 0 && `(${totalCount})`}
        </span>
        {titleAccessory}
      </div>
      <div className="dashboard-section-controls">
        <Tabs value={viewMode} onValueChange={(next) => onViewModeChange(next as ProjectViewMode)}>
          <TabsList variant="stretch" className="dashboard-view-toggle" aria-label="Project view">
            <TabsTab
              value="grid"
              className="dashboard-view-toggle-btn"
              leftIcon={<GridIcon size={16} />}
              aria-label="Grid view"
              title="Grid view"
            >
              <span className="dashboard-view-toggle-label">Grid</span>
            </TabsTab>
            <TabsTab
              value="list"
              className="dashboard-view-toggle-btn"
              leftIcon={<ListIcon size={16} />}
              aria-label="List view"
              title="List view"
            >
              <span className="dashboard-view-toggle-label">List</span>
            </TabsTab>
          </TabsList>
        </Tabs>
        <Dropdown
          align="right"
          menuClassName="sort-dropdown-menu"
          trigger={(p) => (
            <Button
              variant="default"
              size="default"
              width="hug"
              className="sort-dropdown-btn"
              data-education-id="sort-projects"
              rightIcon={<ChevronIcon />}
              {...p}
            >
              {SORT_LABELS[sortBy]}
            </Button>
          )}
        >
          {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
            <DropdownItem
              key={option}
              active={sortBy === option}
              onSelect={() => onSortChange(option)}
            >
              <span>{SORT_LABELS[option]}</span>
              {sortBy === option && <CheckIcon />}
            </DropdownItem>
          ))}
        </Dropdown>
        <IconButton
          variant="default"
          size="default"
          width="hug"
          className="new-folder-btn"
          data-education-id="new-folder-button"
          onClick={() => {
            void trackEvent('new_folder_clicked', { $screen_name: 'Dashboard' });
            onNewFolder();
          }}
          title="New Folder"
          aria-label="New Folder"
          icon={<FolderPlusIcon size={14} />}
        />
      </div>
    </div>
  );
}
