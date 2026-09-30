import { useId, useLayoutEffect, useRef, useState } from 'react';
import { TextButton } from '../primitives/TextButton';

interface ExpandableTeamTextProps {
  text: string;
  textClassName: string;
}

/** Keeps long prose readable in the Team feed and comment reader. */
export function ExpandableTeamText({ text, textClassName }: ExpandableTeamTextProps) {
  const descriptionId = useId();
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const description = descriptionRef.current;
    if (!description) return;

    const measureOverflow = () => {
      if (expanded) return;
      const nextCanExpand = description.scrollHeight > description.clientHeight;
      setCanExpand((current) => (current === nextCanExpand ? current : nextCanExpand));
    };

    measureOverflow();
    if (typeof ResizeObserver !== 'function') return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(description);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="team-expandable-text">
      <p
        id={descriptionId}
        ref={descriptionRef}
        className={`${textClassName} team-expandable-text__content${
          expanded ? '' : ' is-clamped'
        }${canExpand && !expanded ? ' is-faded' : ''}`}
      >
        {text}
      </p>
      {canExpand && (
        <TextButton
          className="team-expandable-text__toggle"
          aria-controls={descriptionId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Read less' : 'Read more'}
        </TextButton>
      )}
    </div>
  );
}
