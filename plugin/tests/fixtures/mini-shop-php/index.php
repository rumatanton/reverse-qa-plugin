<?php
session_start();
include("db.php");
$res = $db->query("SELECT id, name, price FROM products");
while ($row = $res->fetch_assoc()) {
    echo "<a href='cart.php?add={$row['id']}'>{$row['name']}</a> {$row['price']}<br>";
}
