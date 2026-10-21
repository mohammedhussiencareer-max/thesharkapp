import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { RequireOwner } from '@/auth/RequireOwner';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { HomePage } from '@/pages/HomePage';
import { ItemsPage } from '@/pages/ItemsPage';
import { LoginPage } from '@/pages/LoginPage';
import { OpeningPage } from '@/pages/OpeningPage';
import { PurchasesPage } from '@/pages/PurchasesPage';
import { SalesPage } from '@/pages/SalesPage';
import { SalesShiftPage } from '@/pages/SalesShiftPage';
import { MissingEnvScreen } from '@/pages/MissingEnvScreen';
import { NotFoundPage } from '@/pages/NotFoundPage';

function HomeRoute() {
  const { email, signOut } = useAuth();
  return <HomePage email={email ?? ''} onSignOut={() => void signOut()} />;
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
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App() {
  if (!supabase) {
    return <MissingEnvScreen />;
  }

  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
