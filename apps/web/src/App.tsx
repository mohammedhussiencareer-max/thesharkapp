import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { RequireOwner } from '@/auth/RequireOwner';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { HomePage } from '@/pages/HomePage';
import { ItemsPage } from '@/pages/ItemsPage';
import { LoginPage } from '@/pages/LoginPage';
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
        path="/items"
        element={
          <RequireOwner>
            <ItemsPage />
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
