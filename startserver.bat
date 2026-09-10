@echo off
REM Serves the folder and opens the 3D build. Any static server works;
REM the only reason one is needed is that browsers refuse ES modules
REM over file:// -- double-clicking index.html will not work.
start "" http://localhost:8080/3d/
python -m http.server 8080 || python3 -m http.server 8080
