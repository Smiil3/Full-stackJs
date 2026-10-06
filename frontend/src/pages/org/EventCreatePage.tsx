import { useNavigate, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useCreateEvent, useOrgSettings } from '../../api/hooks/org';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor } from '../../auth/roles';
import { PageLoader } from '../../components/PageLoader';
import { EventEditor } from './EventEditor';

export function EventCreatePage() {
  const { orgId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const settings = useOrgSettings(orgId);
  const create = useCreateEvent(orgId);
  const role = membershipFor(user, orgId)?.role ?? 'MANAGER';
  if (settings.isPending) return <PageLoader />;
  return (
    <section className="page">
      <h1>Nouvel événement</h1>
      <p className="muted">L’événement est créé en brouillon : ajoutez ensuite les types de places puis publiez-le.</p>
      <EventEditor
        event={null}
        settings={settings.data}
        role={role}
        submitLabel="Créer le brouillon"
        pending={create.isPending}
        error={create.error}
        onCreate={(body) => {
          create.mutate(body, { onSuccess: (e) => void navigate(apiPath`/org/${orgId}/events/${e.id}`) });
        }}
      />
    </section>
  );
}
