<?php
session_start();
include("header.php");
if (!isset($_SESSION["ADMIN"])) {
    header("Location: ../login.php");
}
include("../db.php");
$res = $db->query("SELECT COUNT(*) AS n, SUM(total) AS revenue FROM orders");
$row = $res->fetch_assoc();
echo "<p>Orders: {$row['n']} Revenue: {$row['revenue']}</p>";
