import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { RequireOwner } from '@/auth/RequireOwner';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
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
