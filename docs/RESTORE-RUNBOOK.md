# دليل الاستعادة (Restore)

استخدم الدليل ده لو مشروع Supabase اتمسح أو بقى بايظ. اتبع الخطوات بالترتيب. متقفزش خطوة.

التفاصيل التقنية في [BACKUP.md](BACKUP.md).

## قبل ما تبدأ

- الاستعادة بتروح في مشروع **فاضي** بس. لو فيه جداول `app` أو `ledger_scratch` السكريبت هيرفض. ده طبيعي ومقصود.
- متحاولش تستعيد في المشروع الشغال. اعمل مشروع جديد.
- كل الأوامر في Git Bash على الكمبيوتر بتاعك.

## 1. جهّز الأدوات

1. ثبّت Node 22.
2. ثبّت أدوات PostgreSQL نسخة 17 (`psql` و`pg_dump` و`pg_restore`). لازم النسخة 17 بالظبط.
3. نزّل الكود: `git clone` للريبو العام `thesharkapp`.
4. في Git Bash قول للسكريبت مكان الأدوات:

```
export BACKUP_PG_BIN="/c/Program Files/PostgreSQL/17/bin"
```

## 2. هات آخر نسخة سليمة

1. افتح الريبو الخاص `thesharkapp-backups`.
2. نزّل أحدث نسخة `backup-...tar.gz` ومعاها ملف `.sha256`. حطهم في نفس الفولدر.
3. افتح آخر تشغيل ناجح وتأكد إنه أخضر.

## 3. اعمل مشروع Supabase جديد فاضي

1. من الـ Dashboard اعمل مشروع جديد. اختار نفس الـ region لو تقدر.
2. متشغلش أي migration عليه.
3. من Authentication: اقفل التسجيل (Signups disabled).
4. من Settings، Data API: ضيف السكيمة `app` في Exposed schemas.
5. من Authentication، Users: اعمل مستخدم المالك (Add user) بالإيميل بتاعك. انسخ الـ UUID بتاعه.

## 4. حط بيانات الاتصال بالمشروع الجديد

من Dashboard، Connect، خد بيانات الـ **Session pooler**. بعد كده في Git Bash:

```
export PGHOST="<host>"
export PGPORT=5432
export PGUSER="postgres.<project ref>"
export PGDATABASE=postgres
export PGSSLMODE=verify-full
export BACKUP_RESTORE_CONFIRM=RESTORE-INTO-EMPTY-PROJECT
read -rs PGPASSWORD; export PGPASSWORD
```

- اكتب الباسورد بعد أمر `read` واضغط Enter. مش هيظهر على الشاشة.
- متكتبش الباسورد في أي ملف ولا في الشات.
- لو الاتصال فشل بسبب الشهادة، نزّل شهادة الـ CA من الـ Dashboard وحط مسارها: `export PGSSLROOTCERT="<path>"`.

## 5. شغّل الاستعادة

```
bash scripts/backup/restore.sh <مسار النسخة>.tar.gz remap <UUID المالك>
```

- لو UUID المالك القديم موجود في المشروع الجديد، ممكن تستخدم `preserve` بدل `remap <UUID>`.
- استنى لحد ما تشوف السطر: `restore complete`.
- السكريبت بيقارن كل جدول وكل دالة بالنسخة. لو فيه فرق بيقول اسمه ويقف.

## 6. لو فشلت الاستعادة

1. اقرا سطر `backup: error [CODE]` وافهم السبب. الأكواد في BACKUP.md.
2. لو الخطأ حصل بعد ما الاستعادة بدأت، المشروع فيه نسخة ناقصة. امسحها:

```
psql -c "drop schema if exists app, ledger_scratch cascade"
```

3. صلّح السبب وشغّل الخطوة 5 من الأول.
4. لو الأمر `TARGET_NOT_EMPTY` ظهر من الأول: ده مشروع مش فاضي. اعمل مشروع جديد.
5. متعدّلش السكريبت عشان يعدّي. لو محتار، وقف واسأل.

## 7. أصلح سجل الـ migrations

المشروع الجديد مفيهوش سجل migrations. من غير الإصلاح، أول `db push` هيحاول يشغل كل حاجة تاني.

1. فك النسخة وهات ملف `manifest.json`:

```
tar -xzf <النسخة>.tar.gz manifest.json
```

2. تأكد إن الكود عندك هو نفس الكود اللي اتعملت بيه النسخة. الأمر `migration repair` بيكتب أرقام الإصدارات بس، فلازم تتأكد الأول إن ملفات الـ migrations مطابقة. المقارنة بالاسم وبصمة الـ SQL، مش برقم الإصدار: الـ migrations اللي اتطبقت على المشروع بأداة Supabase MCP (`apply_migration`) رقم إصدارها بيبقى وقت التطبيق على السيرفر، ومختلف عن رقم الملف في الريبو (`<الإصدار>_<الاسم>.sql`). الاسم هو نفسه على الجهتين. محتاج Docker شغال:

```
git checkout "$(node -p "require('./manifest.json').metadata.appCommit")"
git switch -c "restore-$(date +%Y%m%d)"
supabase start
supabase db reset
PGHOST=127.0.0.1 PGPORT=55422 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres PGSSLMODE=disable node scripts/backup/manifest.mjs migrations-check manifest.json
```

- لازم يطلع السطر: `migration history matches the backup`.
- لو طلع اختلاف في أرقام الإصدارات بس، ده طبيعي وبيتكتب كمعلومة. مفيش مشكلة.
- لو طلع إن migration اسمها مختلف أو ناقصة أو زيادة، أو الـ SQL بتاعها اتغير، متكملش. الكود ده مش اللي عمل النسخة. وقف واسأل.

3. اربط المشروع وعلّم الـ migrations إنها اتطبقت. الخيار `--repair-versions` بيطبع أرقام الإصدارات من ملفات الريبو (بيربط كل إصدار قديم بالملف اللي ليه نفس الاسم)، وده اللي لازم يتسجل:

```
supabase link --project-ref <project ref>
supabase migration repair --status applied $(PGHOST=127.0.0.1 PGPORT=55422 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres PGSSLMODE=disable node scripts/backup/manifest.mjs migrations-check manifest.json --repair-versions)
supabase migration list
```

4. لازم القايمة تبين إن المحلي والبعيد زي بعض.
5. افضل على الفرع ده (`restore-...`). ده الكود اللي بيطابق الـ schema المستعادة. متعملش `git checkout main` دلوقتي، والخطوة 9 بتشرح ليه.

## 8. أنشئ مستخدم النسخ الاحتياطي من جديد

1. شغّل ملف `scripts/backup/provision-backup-reader.sql` في SQL editor.
2. حط الباسورد من جهازك:

```
psql "host=<host> port=5432 dbname=postgres user=postgres.<project ref> sslmode=verify-full"
\password backup_reader
```

3. حدّث السيكرتس الثلاثة في الريبو الخاص: `BACKUP_PGHOST` و`BACKUP_PGUSER` و`BACKUP_PGPASSWORD`.

## 9. حدّث التطبيق وجرّبه

التطبيق المثبّت على الكمبيوتر بيحفظ عنوان المشروع والمفتاح جواه وقت البناء، وكمان بيمنع الاتصال بأي مشروع غير القديم. تعديل `.env.production` لوحده مش هيغيّر حاجة في التطبيق المثبّت. لازم تبني التطبيق من جديد وتثبّته.

الاستعادة بترجّع الـ schema زي ما كانت وقت النسخة بالظبط، ومبتوصلهاش لآخر migration. التطبيق بينادي دوال في الداتابيز وشكلها بيتغير مع الـ migrations. مثلاً التطبيق الحالي بيبعت `p_expected_identity` للدالة `app.set_item_opening_price`، والدالة القديمة (خمس معاملات) مبتقبلهوش. لو بنيت آخر `main` على schema أقدم، التطبيق هيفشل في النداءات دي.

- **الأصل: ابني على الفرع `restore-...` اللي عملته في الخطوة 7** (الكود بتاع `appCommit` في النسخة). الخطوات 1 لـ 7 تحت بتتعمل على الفرع ده.
- **لو عايز تنقل لآخر `main`، ده خطوة منفصلة ولازم تتعمل الأول وبالترتيب ده:**
  1. `git checkout main`، وهات الـ migrations اللي في `main` وناقصة من النسخة، بالاسم وبالترتيب: `node scripts/backup/manifest.mjs migrations-pending manifest.json`. لو النسخة فيها migration مش موجودة في `main` الأمر هيفشل: وقف واسأل.
  2. طبّق كل ملف من القايمة بالترتيب على المشروع المستعاد بنفس الطريقة اللي بتتطبق بيها الـ migrations عادةً (`HANDOFF.md`: `apply_migration` من Supabase MCP، والاسم هو اللي بعد رقم الإصدار في اسم الملف).
  3. اتأكد: اعمل `supabase db reset` على `main` محلياً، وصدّر الـ migrations بـ `node scripts/backup/manifest.mjs migrations-export main-migrations.json` (بمتغيرات الاتصال المحلية زي الخطوة 7)، وقارنها بالمشروع المستعاد: `node scripts/backup/manifest.mjs migrations-check main-migrations.json` بمتغيرات اتصال المشروع المستعاد. لازم يطلع `migration history matches the backup`. أي اختلاف معناه migration اتنسيت أو اتطبقت غلط: متبنيش، وقف واسأل.
  4. كرر تعديلات الخطوات تحت على `main` وابني منه.

1. حدّث `apps/web/.env.production` بالـ URL والمفتاح الجديدين (`VITE_SUPABASE_URL` و`VITE_SUPABASE_ANON_KEY`).
2. حدّث `apps/desktop/src-tauri/tauri.conf.json`: في `app.security.csp` وتحت `connect-src` بدّل عنوان المشروع القديم بالجديد: `'self' https://<project ref الجديد>.supabase.co`. متلمسش `devCsp`.
3. ابني ملف التثبيت بالأمر `pnpm desktop:build`، وشغّل ملف الـ setup الجديد على كمبيوتر المالك. بيتثبّت فوق القديم.
4. اتأكد إن التطبيق بيكلم المشروع الجديد: افتح التطبيق، سجل دخول بحساب المالك، وقارن كمية مخزون واحدة بالنسخة. لو الشاشة فاضية أو الدخول فشل بخطأ شبكة، يبقى العنوان أو الـ CSP لسه القديم. متكتبش بيانات جديدة قبل ما ده يشتغل.
5. شوف المخزون، وجرّب شراء، وشوف شهر المصروفات.
6. لو حاجة مش مظبوطة، متكتبش بيانات جديدة. وقف واسأل.
7. اعمل commit لتعديل `.env.production` و`tauri.conf.json` على الفرع `restore-...`. لو عايزهم على `main` انقل نفس التعديلين هناك بس بعد ما تطبّق migrations الـ `main` على المشروع المستعاد وتتأكد منها، ومتدمجش فرع `restore-...` في `main`.

## تمرين الاستعادة (مرة واحدة قبل ما تعتمد على النسخ)

1. استنى 3 أيام خضرا من النسخ اليومي.
2. اعمل مشروع Supabase مجاني تاني مؤقت.
3. اتبع الخطوات من 1 لـ 5 عليه.
4. ابني التطبيق على عنوان المشروع المؤقت (الخطوة 9) وجرّب الدخول. ده بيستبدل التطبيق المثبّت، فبعد ما تخلص ارجع ابنيه وثبّته على المشروع الأصلي.
5. امسح المشروع المؤقت بس بعد موافقتك.
