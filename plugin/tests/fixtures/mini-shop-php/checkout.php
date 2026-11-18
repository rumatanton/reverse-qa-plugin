<?php
session_start();
if (!isset($_SESSION["UID"])) {
    header("Location: login.php");
    exit;
}
include("db.php");
$uid = (int) $_SESSION["UID"];
$db->query("INSERT INTO orders (user_id, total) SELECT $uid, SUM(p.price) FROM cart c JOIN products p ON p.id = c.product_id WHERE c.user_id = $uid");
$db->query("DELETE FROM cart WHERE user_id = $uid");
?>
<form method="post" action="https://pay.example.test/process">
  <input type="hidden" name="order" value="<?php echo $db->insert_id; ?>">
  <button type="submit">Pay</button>
</form>
