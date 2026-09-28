import { Card } from '../src/components/Card';
import { ClientButton } from '../src/components/ClientButton';

export default function Page() {
  return (
    <main>
      <Card title="App Router" tone="accent">
        Static child content
      </Card>
      <ClientButton label="Refresh" />
    </main>
  );
}
