import type { ReactNode } from 'react';
import {
  DecorationNoneIcon,
  EditFieldIcon,
  ElementAsideIcon,
  ElementBodyIcon,
  ElementButtonIcon,
  ElementCircleIcon,
  ElementCodeBlockIcon,
  ElementDetailsIcon,
  ElementDivIcon,
  ElementFooterIcon,
  ElementHeading1Icon,
  ElementHeading2Icon,
  ElementHeading3Icon,
  ElementHeadIcon,
  ElementKbdIcon,
  ElementLinkIcon,
  ElementListIcon,
  ElementListItemIcon,
  ElementMainIcon,
  ElementNavIcon,
  ElementParagraphIcon,
  ElementPathIcon,
  ElementPreIcon,
  ElementSectionIcon,
  ElementSourceIcon,
  ElementSummaryIcon,
  ElementSvgIcon,
  ElementToolbarIcon,
  ElementUnknownIcon,
  ElementVideoIcon,
  ImageIcon,
  ItalicsOnIcon,
} from '@/components/icons';
import type { ElementKind } from '../../lib/edit-structure';

/** The canonical icons for the kinds offered by the Insert Element menu. */
export const ELEMENT_ICONS: Record<ElementKind, ReactNode> = {
  div: <ElementDivIcon />,
  section: <ElementSectionIcon />,
  h1: <ElementHeading1Icon />,
  h2: <ElementHeading2Icon />,
  h3: <ElementHeading3Icon />,
  p: <ElementParagraphIcon />,
  a: <ElementLinkIcon />,
  button: <ElementButtonIcon />,
  img: <ImageIcon />,
  ul: <ElementListIcon />,
  span: <DecorationNoneIcon />,
};

const ELEMENT_TAG_ICONS: Record<string, ReactNode> = {
  ...ELEMENT_ICONS,
  aside: <ElementAsideIcon />,
  body: <ElementBodyIcon />,
  circle: <ElementCircleIcon />,
  code: <ElementCodeBlockIcon />,
  details: <ElementDetailsIcon />,
  footer: <ElementFooterIcon />,
  header: <ElementHeadIcon />,
  i: <ItalicsOnIcon />,
  input: <EditFieldIcon />,
  kbd: <ElementKbdIcon />,
  li: <ElementListItemIcon />,
  main: <ElementMainIcon />,
  nav: <ElementNavIcon />,
  'next-route-announcer': <ElementToolbarIcon />,
  path: <ElementPathIcon />,
  pre: <ElementPreIcon />,
  source: <ElementSourceIcon />,
  summary: <ElementSummaryIcon />,
  svg: <ElementSvgIcon />,
  unknown: <ElementUnknownIcon />,
  video: <ElementVideoIcon />,
};

/** Return the icon for a rendered tag when it has a specific mapping. */
export function getElementIcon(tag: string): ReactNode | undefined {
  const normalizedTag = tag.toLowerCase();
  return (
    ELEMENT_TAG_ICONS[normalizedTag] ??
    (normalizedTag.includes('toolbar') ? <ElementToolbarIcon /> : undefined)
  );
}
