import type { ChangeEvent, RefObject } from 'react';

interface ProjectThumbnailInputProps {
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function ProjectThumbnailInput({ inputRef, onChange }: ProjectThumbnailInputProps) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      className="project-thumbnail-input"
      onChange={onChange}
    />
  );
}
