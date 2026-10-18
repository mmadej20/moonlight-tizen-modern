# Dochodzenie: sporadyczne zawieszenie aplikacji (2026-10-18)

Objaw zgłoszony przez użytkownika: aplikacja czasem się zawiesza i trzeba ją zrestartować, żeby wrócić do streamu.
Zwykle zdarza się raz na początku, potem działa bez problemu, czasem zawiesza się drugi raz.

Status: **przyczyna nie została udowodniona.** Poniżej tylko to, co wynika z logów i z kodu, z oceną pewności.

## 1. Co pokazują dostępne logi (`tools/moonlight-tv-logs`)

- Najnowszy log pochodzi z 2026-08-02, czyli sprzed wszystkich scaleń z upstream. Nie ma logu z opisanego zawieszenia.
- Wszystkie 7 zarejestrowanych sesji wystartowało poprawnie: od `Initializing platform` do `Started` mija 1,0-2,5 s.
- Sesje z 2026-07-29 (45 min) i 2026-08-02 (95 min) kończą się tak samo: pakiety wideo na okno 10 s spadają
  (z ok. 31000 do ok. 20000), potem cisza, pakiety audio też zanikają, potem `Failed to send ENet control packet`
  i rozłączenie ENet. W logu z 2026-08-02 widać to jako `VideoTransportStall noPacketMs=1037`, potem `6037`, oraz
  serię 31 komunikatów `Control message took over 10 ms to send`. Log z 2026-07-29 powstał jeszcze bez heartbeatu
  stall, ale ostatnie okno audio ma 67 pakietów zamiast ok. 780. W obu cleanup klienta kończy się w całości
  (ok. 160 ms). To wygląda na utratę łączności TV (Wi-Fi/sieć), a nie na zawieszenie kodu.
- Sesje z 2026-07-28 (profil 9.0/jQuery 4) urywają się bez cleanupu. Tam log po prostu przestaje powstawać.
- Pierwsze okno `AudioTransportStats` bywa bardzo długie (22-40 s, 1-250 pakietów). To artefakt raportowania: okno
  zamyka się dopiero po nadejściu pakietu, a host nie wysyła audio w ciszy. Nie jest to awaria klienta.

## 2. Dlaczego logowanie nie pokazuje przyczyny

- Zapis logów robi **wyłącznie wątek główny**: `diagnostic_logs.js:177` (`setInterval(pollNative, 1000)`), potem
  `Module.drainDiagnosticLogs()` i zapis przez `tizen.filesystem`. Natywny bufor (256 KB) zbierają wątki robocze,
  ale nikt go nie opróżnia, gdy wątek główny stoi.
- Skutek: zawieszenie wątku głównego i śmierć całego procesu dają w logu ten sam obraz, czyli nagłe urwanie.
  Wniosek z 2026-07-28 „zatrzymał się cały runtime” opierał się więc na logach, które w obu wariantach musiały się urwać.
- `beginSession` (`diagnostic_logs.js:260`) kopiuje bieżący log do „previous” przy każdym nowym streamie. Log
  zawieszonej sesji trzeba wyeksportować zaraz po restarcie aplikacji, przed kolejnym startem streamu.

## 3. Znaleziska w kodzie (od najlepiej pasującego do objawu)

### A. Jedna kolejka HTTP dla wszystkiego, w tym dla okładek (pewność mechanizmu: wysoka; że to Twoja przyczyna: nieznana)

- `wasm/dispatcher/lib.hpp:82`: `Dispatcher` ma jeden wątek (`std::thread thread_`). Przez niego idą wszystkie
  `OpenUrl`, `Pair`, `STUN`, `WakeOnLan` (`http.cpp:192`, `main.cpp:608/643/657`), w kolejności FIFO.
- `index.js:2641-2648`: po wczytaniu listy aplikacji każda aplikacja bez okładki w cache zleca osobne pobranie
  (`utils.js:589`, limit 10 s). Brak limitu współbieżności i brak anulowania. Komentarz autorów w tym miejscu
  sam opisuje skutek: `/serverinfo` stoi „behind 40+ concurrent image downloads”.
- `index.js:2970`: `startGame` zaczyna od `host.refreshServerInfo()`, a spinner (`showStreamMode`, `index.js:3080`)
  pojawia się dopiero po jego zakończeniu. Potem `resumeApp/launchApp` (`utils.js:892/901`) też idą przez tę kolejkę.
- W tym forku limit czasu żądania liczy się od jego rozpoczęcia, więc żądanie w kolejce nie wygasa, tylko czeka.
- Pasuje do wzorca „raz na początku, potem dobrze”: okładki zapisują się na dysk (`utils.js:599`), więc zimny cache
  występuje tylko po instalacji, nowym hoście lub dodaniu aplikacji, a każdy restart przynosi postęp w cache.
- Czego nie wiemy: ile żądań stoi w kolejce na TV i jak długo trwa. Nie ma logu czasu oczekiwania w kolejce.

### B. Ścieżki, które zostawiają stan „zablokowany do restartu” (pewność: wysoka, prawdopodobieństwo wystąpienia: niskie)

- `main.cpp:134-141` i `156-163`: `StopThreadFunc` wychodzi wcześnie przy błędzie `Join`, bez `onConnectionStopped` i bez
  `MarkIdle()`. JS nigdy nie dostaje `streamTerminated`, a `ConnectionLifecycle` zostaje w `Stopping`.
- `main.cpp:354-360`: przy błędzie `m_StopThread.Join()` wywoływane jest `BeginStop()` bez żadnego wątku zatrzymania,
  więc stan zostaje w `Stopping`.
- W obu przypadkach każdy kolejny `StartStream` zwraca `GS_WRONG_STATE`, aż do restartu aplikacji.

### C. Blokada statystyk trzymana podczas `AppendPacket` (pewność: wysoka, wpływ: niski)

- `wasmplayer.cpp:654-791`: `s_VideoStatsMutex` jest trzymany przez cały `AppendPacket` (linia 727).
- `TogglePerformanceStats` (`wasmplayer.cpp:994`) bierze tę blokadę na wątku głównym. Przy wolnym `AppendPacket`
  przełączenie overlayu zablokuje wątek główny.

### D. Ryzyka środowiskowe (niezweryfikowane)

- `CMakeLists.txt:269-283`: sztywna pamięć 128 MB (brak `ALLOW_MEMORY_GROWTH`), stos 16 MB, pula 20 wątków,
  `-DNDEBUG`, `-w`. Wyczerpanie pamięci lub wątków skończyłoby się cichym błędem, bez śladu w logu.
- `PostToJs` i `PostPromiseMessage` (`main.cpp:840-868`) są synchronicznymi wywołaniami wątku głównego (`MAIN_THREAD_EM_ASM`).
  Wątek roboczy, który je wywoła, stoi, dopóki wątek główny nie wykona JS. Nie znaleziono cyklu oczekiwania, ale
  każde zablokowanie wątku głównego zatrzymuje też wątki, które z niego korzystają.

### Sprawdzone i bez zarzutu

`OwnedPthread`, `OperationLatch`, `MediaOperationEpoch`, `DiagnosticLogBuffer::TryAppend` (try_lock), powiadamianie JS po
stronie `streamTerminated`, ścieżka błędu `showApps` (zawsze wywołuje `showAppsMode`, poza odrzuceniem dla `!host.paired`).

## 4. Co rozstrzygnęłoby przyczynę

1. Log zawieszonej sesji wyeksportowany zaraz po restarcie (Current session, przed kolejnym streamem).
2. Pomiar czasu oczekiwania żądań HTTP w kolejce (natywny log: czas od zlecenia do startu, dla żądań dłuższych niż 1 s).
3. Znacznik żywotności wątku głównego zapisywany co sekundę osobno od logów (np. do `localStorage`) oraz znacznik
   „nieczysty koniec poprzedniej sesji” przy starcie. Odróżni zawieszenie wątku głównego od śmierci procesu.
4. Natywny licznik żywotności wątków wideo i audio (log tylko przy anomalii), by odróżnić zatrzymanie renderera od
   zatrzymania transportu.

## 5. Odpowiedzi użytkownika i zmiana oceny

Odpowiedzi użytkownika po pierwszej wersji tej analizy:

- Co widać: zamrożony obraz, po chwili urwany dźwięk, brak reakcji na kontroler i brak możliwości powrotu do menu.
  Aplikację trzeba zamknąć przytrzymaniem Back na pilocie TV.
- Kiedy: po pierwszych minutach streamu.
- Jak często: prawie zawsze przy pierwszym streamie danego dnia, potem działa bez problemu.
- Sieć i profil: Wi-Fi, profil 5.5.

Co z tego wynika:

- To **nie jest zawieszenie na starcie**, więc kolejka okładek (punkt 3A) może być tylko czynnikiem pobocznym.
- Obraz zamarza od razu, a dźwięk urywa się dopiero po chwili, bo bufor audio w TV się opróżnia. To sygnatura
  **jednoczesnego zatrzymania wszystkiego, co dotyka wątku głównego lub potoku mediów**, a nie samej sieci.
- Utrata sieci kończy się w logach rozłączeniem ENet po ok. 8 s i powrotem do listy aplikacji. Tutaj nic takiego nie
  następuje, a lokalne wyjścia ze streamu (czerwony przycisk pilota i kombinacja na padzie) też nie działają.
  To wskazuje na zamrożony wątek główny albo cały proces, a nie na zerwane Wi-Fi.
- Korelacja z pierwszym streamem dnia: TV po rozruchu wykonuje w tle własne zadania (pamięć, CPU, Wi-Fi), a
  aplikacja raz na dobę sprawdza aktualizacje (`checkForAppUpdatesAtStartup`). Nie ma dowodu, że któreś z nich jest
  przyczyną. Dlatego zamiast kolejnych hipotez dodano narzędzia, które to rozstrzygną.

## 6. Co wdrożono (2026-10-18)

1. **Strażnik strumienia**: tętno zapisywane co sekundę, raport „poprzednie uruchomienie skończyło się podczas
   streamu" przy kolejnym starcie, wykrywanie przestojów wątku głównego.
2. **Zdrowie streamu** po stronie natywnej: liczniki pakietów wideo i audio, czas wywołań `AppendPacket`, czas rundy
   wątku wejścia (sonda responsywności wątku głównego), czas oczekiwania wątków roboczych na wątek główny, rozmiar sterty.
3. **Log kolejki HTTP**: żądania czekające w kolejce co najmniej 1 s lub trwające co najmniej 3 s (tylko ścieżka URL).
4. **Okładki**: najwyżej 2 pobierania naraz, porzucanie przestarzałych, anulowanie przy wejściu do streamu, natychmiastowa
   informacja „Starting …" po wciśnięciu aplikacji.
5. **Odporność cyklu życia**: zatrzymanie zawsze powiadamia interfejs i wraca do stanu bezczynności; nieudany start oddaje
   miejsce przez `AbortStart`.

Jak odczytać wynik po następnym zawieszeniu: sekcja „Diagnosing a freeze" w `docs/diagnostic-logs.md`.

## 7. Pozostałe hipotezy do rozstrzygnięcia po zebraniu danych

- Zablokowane wywołanie platformowego `AppendPacket` (potok mediów Samsunga): pokaże to `videoAppendBlockedMs`.
- Zablokowany lub zagłodzony wątek główny (pytania o gamepad są synchronicznie przekazywane do wątku głównego ok. 200
  razy na sekundę): pokaże to `inputPollMaxMs` i `inputPollBlockedMs`.
- Wyczerpanie sztywnej sterty 128 MB: pokaże to `heap`.
- Zabicie lub zamrożenie całej aplikacji przez TV: wszystkie liczniki zatrzymają się razem z tętnem.
- Jeśli wątek główny okaże się winny, kolejny krok to wyprowadzenie z wątków roboczych synchronicznych wywołań
  `PostToJs` i zapytań o gamepad.

## 8. Pytania (pierwotne, już odpowiedziane powyżej)

- Co dokładnie widać: zamrożony obraz z działającym dźwiękiem, czarny ekran ze spinnerem, nieruchoma lista aplikacji, brak reakcji pilota?
- Kiedy: zaraz po wciśnięciu aplikacji, w pierwszych minutach streamu, czy po wielu minutach?
- Czy dzieje się po świeżej instalacji lub po dodaniu aplikacji na hoście? Ile aplikacji ma host?
- Wi-Fi czy Ethernet, jaki model TV, który WGT jest zainstalowany (profil 5.5 czy 9.0)?
