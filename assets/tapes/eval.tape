# Renders assets/generated/gestalt-eval.gif. Run from the repo root: vhs assets/tapes/eval.tape
Output assets/generated/gestalt-eval.gif

Set Shell "bash"
Set FontSize 15
Set Width 1000
Set Height 420
Set Padding 24
Set Theme { "name": "gestalt", "background": "#101413", "foreground": "#c7cfcb", "cursor": "#36d58e", "selection": "#2b3330", "black": "#101413", "red": "#e5606c", "green": "#36d58e", "yellow": "#ffb341", "blue": "#3fb7e8", "magenta": "#d58ad0", "cyan": "#3fb7e8", "white": "#c7cfcb", "brightBlack": "#5d6762", "brightRed": "#ff7b86", "brightGreen": "#5ee6a8", "brightYellow": "#ffc670", "brightBlue": "#6fcaf0", "brightMagenta": "#e3a8df", "brightCyan": "#6fcaf0", "brightWhite": "#ffffff" }
Set TypingSpeed 45ms

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "npm run --silent eval"
Sleep 400ms
Enter
Sleep 5s
