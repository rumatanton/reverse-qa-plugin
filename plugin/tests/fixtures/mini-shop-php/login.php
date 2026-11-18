<?php
session_start();
include("db.php");
if (isset($_POST["email"])) {
    $email = $db->real_escape_string($_POST["email"]);
    $res = $db->query("SELECT id, pass_hash FROM users WHERE email = '$email'");
    $row = $res->fetch_assoc();
    if ($row && password_verify($_POST["password"], $row["pass_hash"])) {
        $_SESSION["UID"] = $row["id"];
        header("Location: index.php");
        exit;
    }
    echo "Invalid login";
}
?>
<form method="post" action="login.php">
  <input name="email" type="email">
  <input name="password" type="password">
  <button type="submit">Log in</button>
</form>
