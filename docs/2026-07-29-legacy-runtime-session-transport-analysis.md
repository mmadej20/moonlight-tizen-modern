# Analiza sesji legacy runtime z przycięciami i requestami IDR

## Źródło i kontekst

Analizowany plik:
`tools/moonlight-tv-logs/moonlight-current-session-2026-07-28T20-26-26.207Z.log`

SHA-256:
`8CF75CDA4247FA876C77FF4C50DECE5F1000F72BF467ACD81326743D69A03781`

Plik ma 1317 linii i 224540 bajtów. Sesja używała:

- HEVC Main 5.1;
- 3840x2160 przy 60 FPS;
- limitu 43 Mbps;
- wyłączonego lokalnego frame pacingu.

Zgodnie z informacją z testu sesja pochodzi z diagnostycznego WGT z profilem
legacy (`required_version=5.5`, jQuery 2.2.0), zbudowanego z commita
`ac1a2287c503fe03799f45c68cc7abafea2a3814`.

Stream działał około 37 minut i 6 sekund. Nie zakończył się crashem klienta.
Host wysłał `0x80030023` (`NVST_DISCONN_SERVER_TERMINATED_CLOSED`), który
moonlight-common-c normalizuje do poprawnego zakończenia, jeżeli wcześniej
odebrano ramki. Następnie wszystkie strumienie i platforma zakończyły cleanup,
a ostatnim wpisem jest `[2264136 ms] done`.

## Najważniejszy wniosek

Przyczyną burz IDR były trzy krótkie, ale bardzo silne epizody utraty pakietów
przed dekoderem. Nie ma dowodów na problem dekodera HEVC ani Samsung
`AppendPacket()`:

- łącznie 341 ramek w trzech ciągłych zakresach było nieodtwarzalnych przez FEC;
- dla tych ramek brakowało co najmniej 3546 pakietów do progu rekonstrukcji;
- dokładnie w tych samych okresach wystąpiły braki pakietów audio, nieudane FEC
  i PLC;
- nie wystąpiła korupcja ramki w depakietyzatorze ani overflow kolejki decode
  units;
- wszystkie odebrane IDR-y zostały poprawnie złożone;
- wszystkie 11 appendów diagnostycznych IDR zakończyło się `success=1`,
  `result=0`;
- najwolniejszy append IDR trwał 4,6 ms, średnio 1,66 ms;
- nie wystąpił żaden błąd dekodowania Opus ani appendu audio.

To lokalizuje źródło problemu w torze host -> sieć -> odbiór UDP na TV, przed
depakietyzacją i dekoderem. Sam log klienta nie rozstrzyga jeszcze pomiędzy:

1. utratą/przeciążeniem w sieci;
2. chwilowym zatrzymaniem wysyłania lub przeciążeniem hosta;
3. zagłodzeniem wątków odbiorczych albo przepełnieniem buforów UDP na TV.

`Unrecoverable frame` zawiera jednak częściowo odebrane pakiety każdej ramki.
To nie jest wyłącznie przeskok numeracji ramek po stronie hosta: klient dostawał
fragmenty ramek, ale za mało danych i FEC, aby je odbudować.

## Trzy burze utraty obrazu

| Epizod | Czas od startu streamu | Nieodtwarzalne ramki | Minimalny deficyt pakietów | Audio w tym samym czasie | Requesty IDR | Recovery |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| 1 | około 1:31-1:32 | 115 (`4486-4600`) | 1641 | 1 nieudany FEC, 76 pominiętych pełnych bloków, 1 PLC | 2 | IDR `4617`, 251 ms od pierwszego requestu |
| 2 | około 12:34-12:36 | 132 (`43635-43772`) | 962 | 4 nieudane FEC, 5 PLC | 7 | pierwszy IDR `43779`, 590 ms od pierwszego requestu |
| 3 | około 22:36-22:38 | 94 (`79520-79617`) | 943 | 6 nieudanych FEC, 11 PLC | 6 | pierwszy IDR `79646`, 1586 ms od pierwszego requestu |

Łącznie log zawiera 16 wysłanych requestów IDR, ale jeden jest prawidłowym
requestem startowym. Pozostałe 15 requestów nie oznacza 15 niezależnych awarii:
są skupione w tylko trzech burzach utraty.

Powtórzenia są konsekwencją dalszego odbierania niekompletnych ramek podczas
oczekiwania na recovery oraz osiągania `CONSECUTIVE_DROP_LIMIT`. W drugim
epizodzie host odpowiedział na serię requestów sześcioma IDR-ami, które renderer
przyjął poprawnie. Taka seria dużych klatek kluczowych może dodatkowo obciążyć
już niestabilne łącze, ale jest skutkiem pierwotnej utraty, a nie jej pierwszą
przyczyną.

W żadnym z epizodów nie ma:

- `Depacketizer detected corrupt frame`;
- `Video decode unit queue overflow`;
- błędu `VideoRenderer IDR append returned`;
- zatrzymania callbacku renderera na appendzie.

## Statystyki transportu wideo

W oknach obejmujących trzy burze maksymalna przerwa pomiędzy odebranymi
pakietami rosła do 221-242 ms:

| Epizod | Okno przed/w trakcie | Pakiety w 10 s | `maxGapMs` | Kolejne stabilne okno |
| --- | ---: | ---: | ---: | ---: |
| 1 | 128828 ms | 31564 | 221 | 31825 pakietów, 18 ms |
| 2 | 788987 ms | 33096 | 226 | 33939 pakietów, 19 ms |
| 3 | 1389208 ms | 32555 | 242 | 33411 pakietów, 19 ms |

Liczba pakietów w całych 10-sekundowych oknach pozostawała wysoka. Nie jest to
ciągły brak przepustowości, lecz krótkie skumulowane przerwy i utrata pakietów.
Po każdym epizodzie transport wracał do normalnych wartości.

## Częstsze krótkie przycięcia bez IDR

Poza trzema dużymi epizodami wystąpiły także powtarzające się krótkie przerwy,
które nie niszczyły kompletnej ramki i dlatego nie wymagały IDR.

Kontroler audio wykonał:

- 633 soft dropy;
- 133 hard dropy;
- łącznie 766 dropów z 439906 callbacków, czyli około 0,174%;
- łącznie 3,83 s pominiętego audio przy ramkach po 5 ms.

Dropy nie były równomierne. Utworzyły 20 skupisk. Każde z 20 skupisk koreluje
czasowo z oknem transportu wideo, w którym `maxGapMs` wynosił od 187 do 294 ms.
To bardzo mocny dowód, że częste przycięcia nie powstają wyłącznie wewnątrz
kontrolera audio. Audio i wideo jednocześnie widzą krótką pauzę, po której
pakiety przychodzą serią.

W 17 łagodniejszych skupiskach `leadMaxMs` dochodził zwykle do 222-247 ms.
Przekracza to soft watermark kontrolera równy 200 ms, więc kontroler pomijał co
dziesiąty pakiet do zejścia poniżej 120 ms. W trzech burzach utraty
`leadMaxMs` osiągnął około 354-355 ms, przekraczając hard watermark 350 ms.
Wszystkie 133 hard dropy należą do tych trzech burz.

Kontroler działa więc zgodnie z aktualnymi progami i nie dropuje agresywnie w
stanie stabilnym. Przy powtarzających się pauzach około 200-300 ms jego korekta
jest jednak skupiona w krótkich seriach, które mogą być słyszalne jako
mikroprzycięcia.

## Znaczenie `mediaOffsetMs`

`mediaOffsetMs` zaczyna się od około 21649 ms i kończy przy około 25878 ms.
Nie jest to bezpośredni pomiar różnicy audio-wideo. Diagnostyka liczy:

```text
czas od pierwszego callbacku audio - PTS ostatnio appendowanego audio
```

Na początku logu po komunikacie o pierwszym pakiecie audio nastąpiło około
21,6 s z bardzo małą liczbą callbacków: pierwsze okno 23,6 s zawiera tylko 115
pakietów audio, czyli 0,575 s materiału. To utworzyło początkowy offset.

Soft i hard dropy nie zwiększają `s_pktPts`, więc 766 dropów dodaje kolejne
3,83 s do tego licznika. Wzrost `mediaOffsetMs` jest zatem spójny z początkową
przerwą i pomijanymi pakietami; nie świadczy o 25-sekundowym buforze ani
25-sekundowym opóźnieniu dźwięku.

## Korelacja z profilem legacy

Ta sesja jest istotnie dłuższa od wcześniejszych sesji kończących się nagłym
urwaniem runtime:

- działała ponad 37 minut;
- telemetryka audio i wideo była aktywna do końca;
- nie ma samotnego uszkodzonego bajtu na końcu pliku;
- host zakończył sesję kontrolowanym komunikatem;
- cleanup klienta został wykonany w całości.

Wspiera to wynik testu A/B użytkownika: crashe korelują z nowszym profilem
pakietu, a nie z dzisiejszymi zmianami audio/HEVC.

Należy jednak zachować precyzyjne nazewnictwo. Commit `7eff49d` nie zmienił
kompilatora WASM: oba warianty używają Tizen Studio 6.1 i Samsung Emscripten
1.39.4.7. Wariant A/B zmienił jednocześnie:

- `required_version` z 9.0 na 5.5;
- jQuery z 4.0.0 na 2.2.0.

Log potwierdza stabilną sesję na profilu legacy, ale sam nie rozdziela wpływu
tych dwóch zmiennych i nie zawiera stack trace'a wcześniejszych crashy.
Technicznie potwierdzona jest korelacja z profilem runtime/frontendu, nie z
inną wersją toolchainu kompilującego C/C++.

## Co rozstrzygnie sieć kontra host/TV

Najbardziej wartościowe są logi Sunshine obejmujące trzy przedziały względem
startu sesji:

- około 1:31-1:33;
- około 12:34-12:36;
- około 22:36-22:38.

Jeżeli Sunshine w tych momentach raportuje normalny capture/encode i ciągłą
wysyłkę, problem leży w sieci albo po stronie odbioru UDP na TV. Jeżeli host ma
jednocześnie frame-capture overshoot, encoder stall albo przerwę w wysyłce,
źródłem jest host. Packet capture lub liczniki interfejsu TV/ routera mogą
następnie rozdzielić utratę w sieci od przepełnienia bufora odbiorczego klienta.

Na podstawie samego logu nie ma uzasadnienia do zmiany dekodera HEVC ani
Samsung renderer. Najpierw należy rozstrzygnąć wspólną przerwę transportową,
która jednocześnie dotyka audio i wideo.
