import { useSyncExternalStore, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { InactiveTabNotice } from '@/auth/InactiveTabNotice';
import { RequireOwner } from '@/auth/RequireOwner';
import {
  getActiveTabSnapshot,
  registerActiveTabLifecycle,
  subscribeActiveTab,
  takeOverActiveTab,
} from '@/lib/active-tab';
import { useAuth } from '@/lib/auth-context';
import {
  activateAuthStore,
  deactivateAuthStore,
  startAuth,
} from '@/lib/auth-store';
import { setHeldWritesTabActive } from '@/lib/held-writes';
import { initPwa, setPwaTabActive } from '@/lib/pwa';
import * as supabaseMod from '@/lib/supabase';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ActivationPage } from '@/pages/ActivationPage';
import { CountsPage } from '@/pages/CountsPage';
import { HomePage } from '@/pages/HomePage';
import { MappingPage } from '@/pages/MappingPage';
import { PackagingPage } from '@/pages/PackagingPage';
import { ItemsPage } from '@/pages/ItemsPage';
import { LoginPage } from '@/pages/LoginPage';
import { OpeningPage } from '@/pages/OpeningPage';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';
import { PurchasesPage } from '@/pages/PurchasesPage';
import { RecipeImportPage } from '@/pages/RecipeImportPage';
import { RecipePage } from '@/pages/RecipePage';
import { RecipesPage } from '@/pages/RecipesPage';
import { OrderCostPage } from '@/pages/OrderCostPage';
import { SalesPage } from '@/pages/SalesPage';
import { SortingPage } from '@/pages/SortingPage';
import { SalesShiftPage } from '@/pages/SalesShiftPage';
import { WastePage } from '@/pages/WastePage';
import { MissingEnvScreen } from '@/pages/MissingEnvScreen';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { UpdateBanner } from '@/pwa/UpdateBanner';

function HomeRoute() {
  const { email, signOut, logoutPending = false } = useAuth();
  return (
    <HomePage
      email={email ?? ''}
      logoutPending={logoutPending}
      onSignOut={() => void signOut()}
    />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireOwner>
            <HomeRoute />
          </RequireOwner>
        }
      />
      <Route
        path="/expenses"
        element={
          <RequireOwner>
            <ExpensesPage />
          </RequireOwner>
        }
      />
      <Route
        path="/items"
        element={
          <RequireOwner>
            <ItemsPage />
          </RequireOwner>
        }
      />
      <Route
        path="/recipes"
        element={
          <RequireOwner>
            <RecipesPage />
          </RequireOwner>
        }
      />
      <Route
        path="/mapping"
        element={
          <RequireOwner>
            <MappingPage />
          </RequireOwner>
        }
      />
      <Route
        path="/packaging"
        element={
          <RequireOwner>
            <PackagingPage />
          </RequireOwner>
        }
      />
      <Route
        path="/recipes/import"
        element={
          <RequireOwner>
            <RecipeImportPage />
          </RequireOwner>
        }
      />
      <Route
        path="/recipes/:recipeId"
        element={
          <RequireOwner>
            <RecipePage />
          </RequireOwner>
        }
      />
      <Route
        path="/sales"
        element={
          <RequireOwner>
            <SalesPage />
          </RequireOwner>
        }
      />
      <Route
        path="/sales/:shiftId"
        element={
          <RequireOwner>
            <SalesShiftPage />
          </RequireOwner>
        }
      />
      <Route
        path="/orders/:orderId"
        element={
          <RequireOwner>
            <OrderCostPage />
          </RequireOwner>
        }
      />
      <Route
        path="/activation"
        element={
          <RequireOwner>
            <ActivationPage />
          </RequireOwner>
        }
      />
      <Route
        path="/opening"
        element={
          <RequireOwner>
            <OpeningPage />
          </RequireOwner>
        }
      />
      <Route
        path="/purchases"
        element={
          <RequireOwner>
            <PurchasesPage />
          </RequireOwner>
        }
      />
      <Route
        path="/sorting"
        element={
          <RequireOwner>
            <SortingPage />
          </RequireOwner>
        }
      />
      <Route
        path="/counts"
        element={
          <RequireOwner>
            <CountsPage />
          </RequireOwner>
        }
      />
      <Route
        path="/order-decisions"
        element={
          <RequireOwner>
            <OrderDecisionsPage />
          </RequireOwner>
        }
      />
      <Route
        path="/waste"
        element={
          <RequireOwner>
            <WastePage />
          </RequireOwner>
        }
      />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function handleTabBecomeActive(): void {
  setHeldWritesTabActive(true);
  // Enable Supabase lazily without eagerly constructing GoTrueClient;
  // startAuth() reconciles durable logout records first so auto-refresh
  // cannot race before boot reconciliation (P2-2).
  if (typeof supabaseMod.enableSupabaseClient === 'function') {
    supabaseMod.enableSupabaseClient();
  } else {
    supabaseMod.activateSupabaseClient?.();
  }
  setPwaTabActive(true);
  initPwa();
  activateAuthStore();
  startAuth();
}

function handleTabBecomeInactive(): void {
  deactivateAuthStore();
  supabaseMod.deactivateSupabaseClient?.();
  setHeldWritesTabActive(false);
  setPwaTabActive(false);
}

function subscribeAppActiveTab(listener: () => void): () => void {
  const unregisterLifecycle = registerActiveTabLifecycle({
    onBecomeActive: handleTabBecomeActive,
    onBecomeInactive: handleTabBecomeInactive,
  });
  const unsubscribe = subscribeActiveTab(listener);
  return () => {
    unsubscribe();
    unregisterLifecycle();
  };
}

function ActiveTabGate({ children }: { children: ReactNode }) {
  const tab = useSyncExternalStore(
    subscribeAppActiveTab,
    getActiveTabSnapshot,
    getActiveTabSnapshot,
  );

  if (tab.status === 'checking') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-4 ps-4 pe-4 pt-8 text-start">
        <p>جاري التحقق…</p>
      </main>
    );
  }

  if (tab.status === 'inactive') {
    return (
      <InactiveTabNotice
        takingOver={tab.takingOver}
        onTakeOver={() => void takeOverActiveTab()}
      />
    );
  }

  return children;
}

export function App() {
  if (!supabaseMod.supabase) {
    return <MissingEnvScreen />;
  }

  return (
    <ActiveTabGate>
      <BrowserRouter>
        <AuthProvider>
          <UpdateBanner />
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ActiveTabGate>
  );
}
