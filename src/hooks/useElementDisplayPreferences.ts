import { useLocalStorageFlag } from './useLocalStorageFlag';

const SHOW_TAG_ICONS_STORAGE_KEY = 'elementTreeShowTagIcons';
const SHOW_TAG_SANS_SERIF_STORAGE_KEY = 'elementTreeShowTagSansSerif';
const SHOW_TAG_COLORS_STORAGE_KEY = 'elementTreeShowTagColors';

/** Shared, persisted display preferences for selected-element tag and class labels. */
export function useElementDisplayPreferences() {
  const [showTagIcons, , toggleShowTagIcons] = useLocalStorageFlag(
    SHOW_TAG_ICONS_STORAGE_KEY,
    false
  );
  const [showTagSansSerif, , toggleShowTagSansSerif] = useLocalStorageFlag(
    SHOW_TAG_SANS_SERIF_STORAGE_KEY,
    false
  );
  const [showTagColors, , toggleShowTagColors] = useLocalStorageFlag(
    SHOW_TAG_COLORS_STORAGE_KEY,
    true
  );

  return {
    showTagIcons,
    toggleShowTagIcons,
    showTagSansSerif,
    toggleShowTagSansSerif,
    showTagColors,
    toggleShowTagColors,
  };
}
