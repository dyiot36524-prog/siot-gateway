// 라우팅 + 역할 가드(계획 E1). 다른 역할의 라우트는 /forbidden.
import { useEffect, type ReactNode } from 'react';
import type { ClientOptions, Role } from './api/client';
import { match, navigate, RouterProvider, useLocation } from './lib/router';
import { AddGatewayScreen, GatewayLinkScreen } from './screens/AddGateway';
import { CheckerScreen } from './screens/Checker';
import { LoginScreen } from './screens/Login';
import { PairingScreen } from './screens/Pairing';
import { Forbidden, NotFound, OperatorHome, ResidentHome } from './screens/Placeholders';
import { SiteDetailScreen } from './screens/SiteDetail';
import { SitesScreen } from './screens/Sites';
import { rememberReturnTo, SessionProvider, useSession } from './state/session';
import { SiteLiveProvider } from './state/site';

const HOME: Record<Role, string> = { installer: '/sites', resident: '/home', operator: '/ops' };

interface RouteDef {
  pattern: string;
  roles: Role[];
  render(p: Record<string, string>): ReactNode;
}

const site = (p: Record<string, string>, el: ReactNode) => (
  <SiteLiveProvider key={p.siteId} siteId={p.siteId!}>
    {el}
  </SiteLiveProvider>
);

const ROUTES: RouteDef[] = [
  { pattern: '/sites', roles: ['installer'], render: () => <SitesScreen /> },
  { pattern: '/sites/:siteId', roles: ['installer'], render: (p) => site(p, <SiteDetailScreen />) },
  { pattern: '/sites/:siteId/gateways/add', roles: ['installer'], render: (p) => site(p, <AddGatewayScreen />) },
  { pattern: '/sites/:siteId/pairing', roles: ['installer'], render: (p) => site(p, <PairingScreen />) },
  { pattern: '/sites/:siteId/check', roles: ['installer'], render: (p) => site(p, <CheckerScreen />) },
  { pattern: '/g/:gatewayId', roles: ['installer'], render: (p) => <GatewayLinkScreen gatewayId={p.gatewayId!} /> },
  { pattern: '/home', roles: ['resident'], render: () => <ResidentHome /> },
  { pattern: '/ops', roles: ['operator'], render: () => <OperatorHome /> },
];

function Redirect({ to, keepReturn = false }: { to: string; keepReturn?: boolean }) {
  useEffect(() => {
    if (keepReturn) rememberReturnTo();
    navigate(to, { replace: true });
  }, [to, keepReturn]);
  return null;
}

function Routes() {
  const { path } = useLocation();
  const { me, ready } = useSession();

  if (path === '/login') return me && ready ? <Redirect to={HOME[me.user.role]} /> : <LoginScreen />;
  if (!me) {
    if (!ready) return <div className="splash">시옷</div>;
    return <Redirect to="/login" keepReturn />;
  }
  if (path === '/') return <Redirect to={HOME[me.user.role]} />;
  if (path === '/forbidden') return <Forbidden />;
  for (const r of ROUTES) {
    const p = match(r.pattern, path);
    if (!p) continue;
    if (!r.roles.includes(me.user.role)) return <Redirect to="/forbidden" />;
    return <>{r.render(p)}</>;
  }
  return <NotFound />;
}

export function App({ clientOptions }: { clientOptions?: Omit<ClientOptions, 'onUnauthorized'> }) {
  return (
    <RouterProvider>
      <SessionProvider clientOptions={clientOptions}>
        <Routes />
      </SessionProvider>
    </RouterProvider>
  );
}
