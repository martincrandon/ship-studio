import { useState } from 'react';

export function ClientButton({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((value) => value + 1)}>{label}: {count}</button>;
}
