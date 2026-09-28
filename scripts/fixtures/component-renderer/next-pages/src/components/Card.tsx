import styles from './Card.module.css';
import type { ReactNode } from 'react';

export default function Card({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'accent';
  children?: ReactNode;
}) {
  return <article className={`${styles.card} card-${tone}`}><h1>{title}</h1><div>{children}</div></article>;
}
