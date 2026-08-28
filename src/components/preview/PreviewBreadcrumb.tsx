import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../primitives/Breadcrumb';
import { getElementIcon } from '../edit/element-icons';
import type { ElementPathItem } from '../../lib/edit';

interface PreviewBreadcrumbProps {
  path: readonly ElementPathItem[];
  onSelect: (item: ElementPathItem) => void;
}

function firstClass(className: string) {
  return className.split(/\s+/).find(Boolean);
}

function itemLabel(item: ElementPathItem) {
  const className = firstClass(item.className);
  return `<${item.tagName}>${className ? ` .${className}` : ''}`;
}

function ElementLabel({ item }: { item: ElementPathItem }) {
  const tagName = item.tagName.toLowerCase();
  const className = firstClass(item.className);
  const icon = getElementIcon(tagName);
  return (
    <span className="preview-breadcrumb__label">
      {icon && (
        <span className="preview-breadcrumb__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="preview-breadcrumb__tag">&lt;{tagName}&gt;</span>
      {className && <span className="preview-breadcrumb__class">.{className}</span>}
    </span>
  );
}

/** Shows the selected element and its authored DOM ancestors at the bottom of
 * the preview. Parent entries reselect the exact live DOM node when clicked. */
export function PreviewBreadcrumb({ path, onSelect }: PreviewBreadcrumbProps) {
  if (path.length === 0) return null;

  return (
    <Breadcrumb className="preview-breadcrumb">
      <BreadcrumbList>
        {path.map((item, index) => {
          const current = index === path.length - 1;
          const label = itemLabel(item);
          return (
            <Fragment key={`${item.domPath || label}-${index}`}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {current ? (
                  <BreadcrumbPage aria-current="page" aria-label={`Current element ${label}`}>
                    <ElementLabel item={item} />
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    aria-label={`Select parent ${label}`}
                    title={`Select ${label}`}
                    onClick={() => onSelect(item)}
                  >
                    <ElementLabel item={item} />
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
