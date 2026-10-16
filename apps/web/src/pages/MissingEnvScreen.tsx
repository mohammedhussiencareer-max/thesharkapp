export function MissingEnvScreen() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-2 ps-4 pe-4 pt-8 text-start">
      <h1 className="text-2xl font-semibold">The Shark</h1>
      <p role="alert">التطبيق مش قادر يشتغل لأن إعدادات الاتصال ناقصة.</p>
    </main>
  );
}
