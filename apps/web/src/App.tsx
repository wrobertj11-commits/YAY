import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, type Alert, type Item, type Me, type Summary } from './api.ts';
import { AddSheet } from './screens/AddSheet.tsx';
import { AlertsScreen } from './screens/Alerts.tsx';
import { ConnectScreen } from './screens/Connect.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { ItemScreen } from './screens/ItemScreen.tsx';
import { ListScreen } from './screens/List.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { WelcomeScreen } from './screens/Welcome.tsx';
import { Spinner } from './ui.tsx';

export type Tab = 'home' | 'list' | 'alerts' | 'settings';

export interface AppData {
  me: Me;
  items: Item[];
  summary: Summary;
  alerts: { inbox: Alert[]; upcoming: Alert[] };
}

export interface Nav {
  tab: (t: Tab) => void;
  item: (id: string, cancel?: boolean) => void;
  back: () => void;
  add: () => void;
  connect: () => void;
}

export function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  const [data, setData] = useState<AppData | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [itemView, setItemView] = useState<{ id: string; cancel: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [me, items, summary, alerts] = await Promise.all([
        api<Me>('GET', '/me'),
        api<Item[]>('GET', '/items'),
        api<Summary>('GET', '/summary'),
        api<AppData['alerts']>('GET', '/alerts'),
      ]);
      setData({ me, items, summary, alerts });
      return me;
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        setToken(null);
        setSignedIn(false);
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    if (signedIn) refresh().then((me) => me.connections.length === 0 && setConnecting(true)).catch(() => {});
  }, [signedIn, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!signedIn) {
    return (
      <WelcomeScreen
        onSignedIn={(token) => {
          setToken(token);
          setSignedIn(true);
        }}
      />
    );
  }
  if (!data) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }

  const nav: Nav = {
    tab: (t) => {
      setItemView(null);
      setTab(t);
      window.scrollTo(0, 0);
    },
    item: (id, cancel = false) => {
      setItemView({ id, cancel });
      window.scrollTo(0, 0);
    },
    back: () => setItemView(null),
    add: () => setAdding(true),
    connect: () => setConnecting(true),
  };

  if (connecting) {
    return (
      <ConnectScreen
        me={data.me}
        onChanged={refresh}
        onDone={() => {
          setConnecting(false);
          nav.tab('home');
        }}
      />
    );
  }

  const unread = data.alerts.inbox.filter((a) => !a.readAt).length;

  return (
    <div className="app">
      <main className="content">
        {itemView ? (
          <ItemScreen key={itemView.id} id={itemView.id} startInCancel={itemView.cancel} me={data.me} nav={nav} onChanged={refresh} toast={setToast} />
        ) : tab === 'home' ? (
          <HomeScreen data={data} nav={nav} />
        ) : tab === 'list' ? (
          <ListScreen items={data.items} summary={data.summary} nav={nav} />
        ) : tab === 'alerts' ? (
          <AlertsScreen alerts={data.alerts} items={data.items} nav={nav} onRead={refresh} />
        ) : (
          <SettingsScreen
            me={data.me}
            nav={nav}
            onChanged={refresh}
            toast={setToast}
            onSignOut={() => {
              setToken(null);
              setData(null);
              setSignedIn(false);
            }}
          />
        )}
      </main>

      {!itemView && (
        <button className="fab" onClick={() => setAdding(true)} aria-label="Add a trial or subscription">
          +
        </button>
      )}

      <nav className="tabbar" aria-label="Main">
        {(
          [
            ['home', 'Home', '⌂'],
            ['list', 'Subscriptions', '☰'],
            ['alerts', 'Alerts', '🔔'],
            ['settings', 'Account', '⚙'],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} className={`tab ${tab === key && !itemView ? 'active' : ''}`} onClick={() => nav.tab(key)} aria-current={tab === key && !itemView ? 'page' : undefined}>
            <span className="tab-icon" aria-hidden>
              {icon}
              {key === 'alerts' && unread > 0 && <span className="dot">{unread}</span>}
            </span>
            {label}
          </button>
        ))}
      </nav>

      <AddSheet
        open={adding}
        me={data.me}
        onClose={() => setAdding(false)}
        onAdded={async (msg, itemId) => {
          setAdding(false);
          setToast(msg);
          await refresh();
          if (itemId) nav.item(itemId);
        }}
      />

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
