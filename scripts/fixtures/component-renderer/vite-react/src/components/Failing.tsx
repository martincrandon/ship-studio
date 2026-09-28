export function Failing({ fail = false }: { fail?: boolean }) {
  if (fail) throw new Error('fixture render failure');
  return <p>Healthy renderer</p>;
}
