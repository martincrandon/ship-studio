import styles from './Card.module.css';
import type { ReactNode } from 'react';

export function Card({ title, children }: { title: string; children?: ReactNode }) {
  return <article className={styles.card}><h1>{title}</h1><div>{children}</div></article>;
}
